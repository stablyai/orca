import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBrowserRouteEgressElectron } from '../../browser/browser-route-egress-electron-launch'
import { buildPluginPanelShellHtml } from '../../../shared/plugins/plugin-panel-shell'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../../shared/plugins/plugin-panel-bridge'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A TURN-over-TCP stand-in: counts the connections a peer connection opens to it. */
async function turnListener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const server = createServer((socket: Socket) => {
    connections += 1
    socket.destroy()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('turn listener has no port')
  }
  return { port: address.port, connections: () => connections }
}

const escapeAttribute = (html: string): string =>
  html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const peerConnectionScript = (port: number): string =>
  '<script>try { var pc = new RTCPeerConnection({ iceServers: [{ urls: ' +
  `'turn:127.0.0.1:${port}?transport=tcp', username: 'leak', credential: 'x' }] }); ` +
  "pc.createDataChannel('d'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o) }) " +
  '} catch (_) {}</script>'

const PROBE_MAIN = String.raw`
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
if (process.platform === 'linux') app.disableHardwareAcceleration()
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const timeout = setTimeout(() => app.exit(2), 25000)
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  // Same fence as the main window that hosts plugin panels.
  window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  await window.loadFile(config.pagePath)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  window.destroy()
  writeFileSync(config.resultPath, JSON.stringify({ ok: true }))
  clearTimeout(timeout)
  app.quit()
}).catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error && error.stack || error) }))
  app.exit(1)
})
`

// Why a tripwire, not a guard: it pins the residual documented in plugin-panel-shell.ts. The
// shell fences the panel's own window, but a child srcdoc frame is a new realm that commits
// without will-frame-navigate, and Electron 43 has no per-frame WebRTC switch. When a fix
// lands, flip the nested-frame assertion to expect no connection.
describe('plugin panel WebRTC under Electron', () => {
  it('blocks the panel window but not a nested srcdoc frame', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-panel-webrtc-'))
    roots.push(root)
    const panelTurn = await turnListener()
    const nestedTurn = await turnListener()
    const panel = buildPluginPanelShellHtml(
      `<body><iframe srcdoc="${escapeAttribute(peerConnectionScript(nestedTurn.port))}"></iframe>` +
        `${peerConnectionScript(panelTurn.port)}</body>`
    )
    const pagePath = join(root, 'page.html')
    writeFileSync(
      pagePath,
      `<!doctype html><iframe name="${PLUGIN_PANEL_FRAME_NAME_PREFIX}probe" sandbox="allow-scripts" ` +
        `srcdoc="${escapeAttribute(panel)}"></iframe>`
    )
    const mainPath = join(root, 'main.cjs')
    writeFileSync(mainPath, PROBE_MAIN)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ pagePath, resultPath: join(root, 'result.json') })
    )

    await runBrowserRouteEgressElectron(root, mainPath)

    expect(panelTurn.connections()).toBe(0)
    // Residual today: the nested frame opens a TURN-over-TCP connection out of the panel.
    expect(nestedTurn.connections()).toBeGreaterThan(0)
  }, 60_000)
})
