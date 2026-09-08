// Real-browser acceptance for the video workbench (issue: rename + fullscreen).
// Drives chrome/chrome-headless-shell over CDP, following the repo's
// scripts/browser-entry.mjs / voice-cdp.mjs conventions (plain node, WebSocket
// CDP client, step-wise assertions, JSON report on failure).
//
// Covered against a real browser engine:
//   1. 远端非 localhost 地址 — the fixture supplies a remote browser host to
//      the REAL built studio URL builder and verifies the preview URL uses that
//      host (plus IPv6 bracketing via studioHostLabel). The page fixture itself
//      is served on loopback so the acceptance test stays hermetic.
//   2. Fullscreen API 行为 — trusted CDP mouse clicks toggle the panel root
//      in/out of fullscreen; state is tracked through fullscreenchange.
//   3. iframe/工作台加载与权限 — a cross-origin studio frame with the exact
//      permission attributes the DSH host sets (allow="fullscreen" +
//      allowFullScreen) can enter fullscreen from inside; an identical frame
//      without those attributes is rejected.
//   4. 标签文字 — the built client bundle must ship the 视频工作台 slot label.
//
// The browser binary is located via IPOLLOWORK_VIDEO_BROWSER or the usual
// chrome/chromium paths; without one the test skips (report why).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const pluginRoot = resolve(new URL(".", import.meta.url).pathname, "..");
const remoteHost = process.env.IPOLLOWORK_VIDEO_TEST_HOST ?? "192.168.0.60";

function findBrowser() {
  const explicit = process.env.IPOLLOWORK_VIDEO_BROWSER;
  if (explicit && existsSync(explicit)) return explicit;
  const shellRoot = `${process.env.HOME ?? ""}/.cache/puppeteer/chrome-headless-shell`;
  if (existsSync(shellRoot)) {
    try {
      for (const version of readdirSync(shellRoot, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        const binary = join(shellRoot, version.name, "chrome-headless-shell-linux64", "chrome-headless-shell");
        if (existsSync(binary)) return binary;
      }
    } catch {
      // fall through to system browsers
    }
  }
  for (const candidate of ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome", "/snap/bin/chromium"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function serveFixture(port, map) {
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", `http://${remoteHost}`).pathname;
      const entry = map[path];
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const served = await entry();
      const contentType = path.startsWith("/lib/") || path.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(served);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(error));
    }
  });
  await new Promise((resolvePromise) => server.listen(port, "0.0.0.0", resolvePromise));
  return server;
}

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      resolvePromise({
        close: () => socket.close(),
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((innerResolve, innerReject) => {
            pending.set(id, { resolve: innerResolve, reject: innerReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      const error = new Error("CDP websocket failed.");
      if (!opened) reject(error);
    });
  });
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed.");
  }
  return result.result?.value;
}

async function waitFor(client, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(client, expression)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function clickElement(client, selector) {
  const rect = await evaluate(client, `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`);
  const box = JSON.parse(rect);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function pickTarget(port) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {
      // browser still booting
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Browser never exposed a CDP page target.");
}

test("built client bundle ships the 视频工作台 slot label", async () => {
  const clientBundle = join(pluginRoot, "lib", "client.js");
  if (!existsSync(clientBundle)) {
    assert.fail("lib/client.js is missing — run `pnpm run build:plugin` before the browser acceptance (the package test script does).");
  }
  const source = await readFile(clientBundle, "utf8");
  assert.match(source, /视频工作台/);
  assert.doesNotMatch(source, /label: "Video"/);
});

test("video workbench fullscreen acceptance in a real browser", { timeout: 120_000 }, async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip("no chrome/chromium binary found; set IPOLLOWORK_VIDEO_BROWSER to run the real-browser acceptance");
    return;
  }

  const projectChunks = (await readdir(join(pluginRoot, "lib"))).filter((name) => /^project-.*\.js$/.test(name));
  assert.equal(projectChunks.length, 1, `expected exactly one built project chunk, found: ${projectChunks.join(", ")}`);
  const projectModule = `/lib/${projectChunks[0]}`;

  // The bundler renames chunk exports; locate the URL builder by behavior in
  // node first, then expose it to the page under stable names.
  const chunkExports = await import(pathToFileURL(join(pluginRoot, "lib", projectChunks[0])).href);
  const probe = (key, args) => {
    try {
      return String(chunkExports[key](...args));
    } catch {
      return null;
    }
  };
  const urlKey = Object.keys(chunkExports).find((key) => (
    typeof chunkExports[key] === "function"
    && probe(key, [3678, "video", undefined, undefined, undefined, "192.168.0.60"])?.startsWith("http://192.168.0.60:3678/")
  ));
  const labelKey = Object.keys(chunkExports).find((key) => (
    typeof chunkExports[key] === "function" && probe(key, ["2001:db8::60"]) === "[2001:db8::60]"
  ));
  assert.ok(urlKey, "built project chunk does not export the studio URL builder");
  assert.ok(labelKey, "built project chunk does not export the studio host label helper");

  const fixtureDir = join(pluginRoot, "test", "fixtures");
  const mainPort = await freePort();
  const innerPort = await freePort();
  const cdpPort = await freePort();
  const mainOrigin = `http://127.0.0.1:${mainPort}`;
  const innerOrigin = `http://127.0.0.1:${innerPort}`;

  const panelHtml = () => readFile(join(fixtureDir, "fullscreen-panel.html"), "utf8").then((source) => source);
  const mainServer = await serveFixture(mainPort, {
    "/panel.html": panelHtml,
    "/studio-url.js": async () => `import * as m from ${JSON.stringify(projectModule)};\nexport const hyperframesStudioUrl = m[${JSON.stringify(urlKey)}];\nexport const studioHostLabel = m[${JSON.stringify(labelKey)}];\n`,
    [projectModule]: async () => readFile(join(pluginRoot, "lib", projectChunks[0]), "utf8"),
  });
  const innerServer = await serveFixture(innerPort, {
    "/fullscreen-inner.html": async () => readFile(join(fixtureDir, "fullscreen-inner.html"), "utf8"),
  });

  const userDataDir = join(tmpdir(), `ipollowork-video-browser-${Date.now()}`);
  const browserProcess = spawn(browser, [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--no-proxy-server",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });

  let client;
  try {
    const target = await pickTarget(cdpPort);
    client = await connectCdp(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    // 1. Load the workbench fixture and provide the remote host the DSH page would
    //    expose to the URL builder.
    await client.send("Page.navigate", { url: `${mainOrigin}/panel.html?innerOrigin=${encodeURIComponent(innerOrigin)}&browserHost=${encodeURIComponent(remoteHost)}` });
    await waitFor(client, "Boolean(window.__panel?.ready)", 15_000);

    // 2. 远端非 localhost 地址: the real built URL builder must use the
    //    browser-visible hostname, never the visitor's own localhost.
    const panel = await evaluate(client, "(({ studioUrl, ipv6Label, localhostUrl }) => ({ studioUrl, ipv6Label, localhostUrl }))(window.__panel)");
    assert.ok(panel.studioUrl.startsWith(`http://${remoteHost}:3678/`), `studio URL must target the remote host, got ${panel.studioUrl}`);
    assert.equal(panel.ipv6Label, "[2001:db8::60]");
    assert.ok(panel.localhostUrl.startsWith("http://localhost:3678/"));

    // 3. 标签与 iframe 权限属性: exactly the attributes the DSH host sets.
    const attributes = await evaluate(client, `(() => {
      const granted = document.getElementById("frame-granted");
      return {
        allow: granted.getAttribute("allow"),
        legacy: granted.hasAttribute("allowfullscreen"),
        deniedAllow: document.getElementById("frame-denied").getAttribute("allow"),
        deniedLegacy: document.getElementById("frame-denied").hasAttribute("allowfullscreen"),
        chromeBar: Boolean(document.querySelector('[data-testid="video-studio-chrome"]')),
        button: Boolean(document.querySelector('[data-testid="video-studio-fullscreen"]')),
      };
    })()`);
    assert.equal(attributes.allow, "fullscreen");
    assert.equal(attributes.legacy, true);
    assert.equal(attributes.deniedAllow, null);
    assert.equal(attributes.deniedLegacy, false);
    assert.equal(attributes.chromeBar, true);
    assert.equal(attributes.button, true);

    // 4. Fullscreen API 行为: trusted click enters fullscreen on the panel
    //    root and the chrome state follows fullscreenchange.
    await clickElement(client, "#fullscreen-btn");
    await waitFor(client, "document.fullscreenElement === document.getElementById('panel-root')", 10_000);
    await waitFor(client, "document.getElementById('panel-root').dataset.fullscreen === 'true'", 10_000);
    assert.equal(await evaluate(client, "document.getElementById('panel-root').dataset.fullscreen"), "true");
    assert.equal(await evaluate(client, "document.getElementById('fullscreen-btn').getAttribute('aria-pressed')"), "true");

    // 5. 再次点击退出并恢复.
    await clickElement(client, "#fullscreen-btn");
    await waitFor(client, "document.fullscreenElement === null", 10_000);
    await waitFor(client, "document.getElementById('panel-root').dataset.fullscreen === 'false'", 10_000);
    assert.equal(await evaluate(client, "document.getElementById('panel-root').dataset.fullscreen"), "false");
    assert.equal(await evaluate(client, "document.getElementById('fullscreen-btn').getAttribute('aria-pressed')"), "false");

    // 6. 工作台 iframe 内部全屏: the cross-origin studio frame may enter
    //    fullscreen only because of its permission attributes.
    await clickElement(client, "#frame-granted");
    await waitFor(client, "window.__panel.iframeResults.some((result) => result.frame === 'granted')", 10_000);
    await waitFor(client, "document.fullscreenElement === document.getElementById('frame-granted')", 10_000);
    const granted = await evaluate(client, "window.__panel.iframeResults.find((result) => result.frame === 'granted')");
    assert.equal(granted.ok, true, `granted frame fullscreen failed: ${granted.name}`);

    await evaluate(client, "document.exitFullscreen()");
    await waitFor(client, "document.fullscreenElement === null", 10_000);

    // 7. 负对照: without the attributes the same request is rejected.
    await clickElement(client, "#frame-denied");
    await waitFor(client, "window.__panel.iframeResults.some((result) => result.frame === 'denied')", 10_000);
    const denied = await evaluate(client, "window.__panel.iframeResults.find((result) => result.frame === 'denied')");
    assert.equal(denied.ok, false, "fullscreen inside the frame without allow attributes unexpectedly succeeded");
    assert.ok(["NotAllowedError", "TypeError"].includes(denied.name), `unexpected fullscreen rejection: ${denied.name}`);

    // 8. Rejection resync: a denied request must not wedge the chrome state.
    assert.equal(await evaluate(client, "document.getElementById('panel-root').dataset.fullscreen"), "false");
  } finally {
    try {
      client?.close();
    } catch {
      // ignore
    }
    browserProcess.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        browserProcess.kill("SIGKILL");
        resolvePromise();
      }, 3_000);
      browserProcess.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    for (const server of [mainServer, innerServer]) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
