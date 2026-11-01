import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { runBrowserRouteEgressElectron } from '../../browser/browser-route-egress-electron-launch'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// The real session setup and per-guest policies; the person's clipboard is restored afterwards.
const CLIPBOARD_MAIN = String.raw`
const { app, BrowserWindow, clipboard, protocol } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
if (process.platform === 'linux') app.disableHardwareAcceleration()
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
protocol.registerSchemesAsPrivileged([{
  scheme: 'orca-plugin-frame',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])
const guests = require(config.bundlePath)
app.on('window-all-closed', () => {})
if (process.platform === 'darwin' && app.dock) app.dock.hide()
app.whenReady().then(async () => {
  const timeout = setTimeout(() => app.exit(2), 25000)
  const saved = { text: clipboard.readText(), html: clipboard.readHTML(), image: clipboard.readImage() }
  const plugin = {
    pluginKey: config.pluginKey,
    rootDir: config.pluginRoot,
    contentHash: null,
    manifest: { contributes: { panels: [{ id: 'probe', entry: 'panel.html' }], customEditors: [] } }
  }
  guests.configurePluginFrameGuests({
    findApprovedPlugin: (key) => (key === config.pluginKey ? plugin : null),
    listPluginKeys: () => [config.pluginKey]
  })
  const guest = await guests.preparePluginFrameGuest(config.pluginKey, 'panel', 'probe')
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: guest.partition,
      sandbox: true,
      contextIsolation: true,
      additionalArguments: [...guests.PLUGIN_FRAME_GUEST_RENDERER_ARGUMENTS]
    }
  })
  if (!guests.attachPluginFrameGuest(window.webContents, window.webContents)) throw new Error('not a plugin guest')
  await window.loadURL(guest.url)
  const result = {}
  // Clipboard writes reach the browser process asynchronously.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300))
  try {
    clipboard.writeText('before')
    result.withoutGesture = await window.webContents.executeJavaScript('window.copy("no-gesture")', false)
    await settle()
    result.afterNoGesture = clipboard.readText()
    result.withGesture = await window.webContents.executeJavaScript('window.copy("gesture")', true)
    await settle()
    result.afterGesture = clipboard.readText()
    result.asyncWrite = await window.webContents.executeJavaScript('window.asyncWrite()', true)
    await settle()
    result.afterAsyncWrite = clipboard.readText()
    result.asyncRead = await window.webContents.executeJavaScript('window.asyncRead()', true)
  } finally {
    clipboard.write(saved.image.isEmpty() ? { text: saved.text, html: saved.html } : saved)
  }
  window.destroy()
  writeFileSync(config.resultPath, JSON.stringify({ ok: true, ...result }))
  clearTimeout(timeout)
  app.quit()
}).catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error && error.stack || error) }))
  app.exit(1)
})
`

const PANEL = `<!doctype html><html><body><script>
var pending = '';
document.addEventListener('copy', function (event) {
  event.clipboardData.setData('text/plain', pending); event.preventDefault();
});
window.copy = function (text) { pending = text; return document.execCommand('copy'); };
window.asyncWrite = function () {
  return navigator.clipboard.writeText('async').then(function () { return 'ok' }, function (e) { return 'refused:' + e.name });
};
window.asyncRead = function () {
  return navigator.clipboard.readText().then(function () { return 'ok' }, function (e) { return 'refused:' + e.name });
};
</script></body></html>`

describe('plugin frame guest clipboard under Electron', () => {
  // Why 60s: a real Electron app boots and loads the guest.
  it('copies on a user gesture only, and never through the async Clipboard API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-frame-clipboard-'))
    roots.push(root)
    const pluginRoot = join(root, 'plugin')
    mkdirSync(pluginRoot)
    writeFileSync(join(pluginRoot, 'panel.html'), PANEL)
    const bundlePath = join(root, 'guests.cjs')
    buildSync({
      stdin: {
        contents:
          "export * from './plugin-frame-guest-sessions'\n" +
          "export { attachPluginFrameGuest, PLUGIN_FRAME_GUEST_RENDERER_ARGUMENTS } from './plugin-frame-guest-registry'\n",
        resolveDir: join(process.cwd(), 'src/main/plugins/panels'),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: bundlePath,
      logLevel: 'silent'
    })
    const mainPath = join(root, 'main.cjs')
    writeFileSync(mainPath, CLIPBOARD_MAIN)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        bundlePath,
        pluginKey: 'samples.clipboard-probe',
        pluginRoot,
        resultPath: join(root, 'result.json')
      })
    )

    const result = await runBrowserRouteEgressElectron(root, mainPath)

    expect(result).toMatchObject({
      withoutGesture: false,
      afterNoGesture: 'before',
      withGesture: true,
      afterGesture: 'gesture',
      asyncWrite: expect.stringMatching(/^refused:/),
      afterAsyncWrite: 'gesture',
      asyncRead: expect.stringMatching(/^refused:/)
    })
  }, 60_000)
})
