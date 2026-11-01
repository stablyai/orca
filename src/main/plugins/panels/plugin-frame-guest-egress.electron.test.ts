import { randomUUID } from 'node:crypto'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { runBrowserRouteEgressElectron } from '../../browser/browser-route-egress-electron-launch'

const roots: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function portOf(server: Server | HttpServer): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('listener has no port')
  }
  return address.port
}

/** TURN-over-TCP stand-in: counts the connections a peer connection opens to it. */
async function tcpListener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const server = createServer((socket: Socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((done) => server.close(() => done())))
  return { port: portOf(server), connections: () => connections }
}

/** STUN stand-in: counts UDP datagrams. */
async function udpListener(): Promise<{ port: number; packets: () => number }> {
  let packets = 0
  const socket: UdpSocket = createSocket('udp4')
  socket.on('message', () => (packets += 1))
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((done) => socket.close(() => done())))
  return { port: socket.address().port, packets: () => packets }
}

/** Counts TCP connections, so WebSocket upgrades and beacons are caught as well as requests. */
async function httpListener(): Promise<{ port: number; requests: () => number }> {
  let connections = 0
  const server = createHttpServer((_request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.end('leak')
  })
  server.on('connection', () => (connections += 1))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((done) => server.close(() => done())))
  return { port: portOf(server), requests: () => connections }
}

/** TURN over TCP by IP and by hostname, plus STUN; reports into the top page's `__probe`. */
const peerConnectionScript = (
  tag: string,
  turnPort: number,
  stunPort: number,
  turnHost: string
): string =>
  `try { top.__probe.${tag} = 'ran'; var pc = new RTCPeerConnection({ iceServers: [` +
  `{ urls: 'turn:127.0.0.1:${turnPort}?transport=tcp', username: 'leak', credential: 'x' }, ` +
  `{ urls: 'turn:${turnHost}:${turnPort}?transport=tcp', username: 'leak', credential: 'x' }, ` +
  `{ urls: 'stun:127.0.0.1:${stunPort}' }] }); ` +
  "pc.createDataChannel('d'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o) }) " +
  `} catch (error) { top.__probe.${tag} = 'threw:' + error }`

// Loads the guest the way Orca does: the real session setup, protocol and per-guest policies.
const PROBE_MAIN = String.raw`
const { app, BrowserWindow, protocol } = require('electron')
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
  const guestSession = window.webContents.session
  await guestSession.netLog.startLogging(config.netLogPath)
  await window.loadURL(guest.url)
  await new Promise((resolve) => setTimeout(resolve, 5000))
  const page = await window.webContents.executeJavaScript('window.__probe')
  window.destroy()
  await guestSession.netLog.stopLogging()
  writeFileSync(config.resultPath, JSON.stringify({ ok: true, page, guestUrl: guest.url }))
  clearTimeout(timeout)
  app.quit()
}).catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error && error.stack || error) }))
  app.exit(1)
})
`

type NetLog = {
  constants?: { logEventTypes?: Record<string, number> }
  events?: { type?: number; source?: { id?: number }; params?: unknown }[]
}

/** Host-resolver event names for jobs that mention `host`, correlated by source id. */
function hostResolverEvents(netLogText: string, host: string): string[] {
  let netLog: NetLog
  try {
    netLog = JSON.parse(netLogText)
  } catch {
    // Incremental writes may leave the final array/object unclosed.
    netLog = JSON.parse(`${netLogText.replace(/,\s*$/, '')}]}`)
  }
  const names = new Map(
    Object.entries(netLog.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name])
  )
  const sources = new Set<number>()
  for (const event of netLog.events ?? []) {
    if (event.source?.id !== undefined && JSON.stringify(event.params ?? null).includes(host)) {
      sources.add(event.source.id)
    }
  }
  const found = new Set<string>()
  for (const event of netLog.events ?? []) {
    const name = event.type === undefined ? undefined : names.get(event.type)
    if (
      event.source?.id !== undefined &&
      sources.has(event.source.id) &&
      name?.startsWith('HOST_RESOLVER')
    ) {
      found.add(name)
    }
  }
  return [...found].sort()
}

describe('plugin frame guest egress under Electron', () => {
  // Why 60s: a real Electron guest negotiates WebRTC against local relays and waits out prefetch.
  it('keeps WebRTC, DNS prefetch, preconnect and fetch off the network', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-frame-egress-'))
    roots.push(root)
    const pluginRoot = join(root, 'plugin')
    mkdirSync(pluginRoot)
    const pageTurn = await tcpListener()
    const srcdocTurn = await tcpListener()
    const javascriptTurn = await tcpListener()
    const stun = await udpListener()
    const http = await httpListener()
    const unique = randomUUID().slice(0, 8)
    const hint = (name: string): string => `orca-guest-${name}-${unique}.invalid`
    const hintLinks = (tag: string): string =>
      `<link rel="dns-prefetch" href="https://${hint(`${tag}-dns`)}">` +
      `<link rel="preconnect" href="https://${hint(`${tag}-pre`)}">`
    const hintScript = (tag: string): string =>
      `var l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = 'https://${hint(`${tag}-dyn`)}'; document.head.appendChild(l);`
    const turnHost = `orca-guest-turn-${unique}.invalid`
    // Fresh realms the page makes itself: srcdoc commits without will-frame-navigate, and a
    // javascript: URL document is not a navigation at all, so only the session can fence them.
    const childDocument = (tag: string, port: number): string =>
      `${hintLinks(tag)}<script>${hintScript(tag)}${peerConnectionScript(tag, port, stun.port, turnHost)}</script>`
    // Inline in the parent's own script, so `</` must not close it.
    const literal = (value: string): string => JSON.stringify(value).replaceAll('</', '<\\/')
    writeFileSync(
      join(pluginRoot, 'panel.html'),
      `<!doctype html><html><head>${hintLinks('page')}</head><body><script>` +
        'window.__probe = { fetch: "pending", orca: typeof window.orca };' +
        `fetch('http://127.0.0.1:${http.port}/leak').then(function () { window.__probe.fetch = 'escaped' }, function () { window.__probe.fetch = 'blocked' });` +
        // Every other way out of a page: a socket, a beacon, and fetches from both worker kinds.
        `try { new WebSocket('ws://127.0.0.1:${http.port}/ws') } catch (_) {}` +
        `navigator.sendBeacon('http://127.0.0.1:${http.port}/beacon', 'x');` +
        `var job = "fetch('http://127.0.0.1:${http.port}/worker').catch(function () {})";` +
        "new Worker(URL.createObjectURL(new Blob([job], { type: 'text/javascript' })));" +
        "try { new SharedWorker(URL.createObjectURL(new Blob(['onconnect = function () {};' + job], { type: 'text/javascript' }))) } catch (_) {}" +
        `${hintScript('page')}${peerConnectionScript('page', pageTurn.port, stun.port, turnHost)};` +
        `var s = document.createElement('iframe'); s.srcdoc = ${literal(childDocument('srcdoc', srcdocTurn.port))}; document.body.appendChild(s);` +
        `var j = document.createElement('iframe'); j.src = 'javascript:' + encodeURIComponent(JSON.stringify(${literal(childDocument('javascript', javascriptTurn.port))})); document.body.appendChild(j);` +
        '</script></body></html>'
    )
    const bundlePath = join(root, 'guests.cjs')
    buildSync({
      // Main's real modules: sessions register the hooks the registry's attach runs.
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
    writeFileSync(mainPath, PROBE_MAIN)
    const netLogPath = join(root, 'netlog.json')
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        bundlePath,
        pluginKey: 'samples.egress-probe',
        pluginRoot,
        netLogPath,
        resultPath: join(root, 'result.json')
      })
    )

    const result = await runBrowserRouteEgressElectron(root, mainPath)

    expect(result.guestUrl).toMatch(
      /^orca-plugin-frame:\/\/[0-9a-f]{16}\/panel\.html\?rev=dev-[0-9a-f]{8}-0$/
    )
    // Every realm ran (no preload here, so no window.orca) and none got out.
    expect(result.page).toEqual({
      fetch: 'blocked',
      orca: 'undefined',
      page: 'ran',
      srcdoc: 'ran',
      javascript: 'ran'
    })
    expect(http.requests()).toBe(0)
    expect(pageTurn.connections()).toBe(0)
    expect(srcdocTurn.connections()).toBe(0)
    expect(javascriptTurn.connections()).toBe(0)
    expect(stun.packets()).toBe(0)
    const netLog = readFileSync(netLogPath, 'utf8')
    // TURN hostnames go to the (refusing) proxy unresolved, never to the system resolver.
    expect(hostResolverEvents(netLog, turnHost)).toEqual([])
    for (const tag of ['page', 'srcdoc', 'javascript']) {
      // Preconnect goes through the refusing proxy, so its host is never resolved here.
      expect(hostResolverEvents(netLog, hint(`${tag}-pre`)), `${tag}-pre`).toEqual([])
      // dns-prefetch bypasses the proxy; only the guest renderer's blink setting stops it.
      for (const kind of ['dns', 'dyn']) {
        expect(hostResolverEvents(netLog, hint(`${tag}-${kind}`)), `${tag}-${kind}`).toEqual([])
      }
    }
  }, 60_000)
})
