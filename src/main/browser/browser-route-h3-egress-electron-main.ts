export function browserRouteH3EgressElectronMain(): string {
  return String.raw`
const { app, BrowserWindow, protocol, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))

// Use a local secure scheme so secure-context gating does not mask the egress policy.
protocol.registerSchemesAsPrivileged([
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// Ignore certificate errors so TLS rejection cannot mask egress packets.
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(true)
})

function settle(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function webTransportScript(origin) {
  return [
    "(async () => {",
    "  let transport",
    "  try {",
    "    transport = new WebTransport('https://" + origin + "/')",
    "  } catch (error) { return 'construct-threw:' + String(error && error.name) }",
    "  try {",
    "    await Promise.race([",
    "      transport.ready,",
    "      new Promise((_r, reject) => setTimeout(() => reject(new Error('ProbeTimeout')), 4000))",
    "    ])",
    "    return 'ready'",
    "  } catch (error) {",
    "    return 'rejected:' + String(error && error.name)",
    "  } finally { try { transport.close() } catch (closeError) {} }",
    "})()"
  ].join('\n')
}

function forcedQuicScript(origin) {
  return [
    "(async () => {",
    "  try {",
    "    const response = await Promise.race([",
    "      fetch('https://" + origin + "/', { cache: 'no-store' }),",
    "      new Promise((_r, reject) => setTimeout(() => reject(new Error('ProbeTimeout')), 4000))",
    "    ])",
    "    return 'fetched:' + response.status",
    "  } catch (error) { return 'failed:' + String(error && error.name) }",
    "})()"
  ].join('\n')
}

const DIRECT_SOCKETS_SCRIPT =
  "JSON.stringify({ tcp: typeof TCPSocket, udp: typeof UDPSocket, server: typeof TCPServerSocket })"

const DIRECT_SOCKETS_CONSTRUCT_SCRIPT =
  "(() => { try { new TCPSocket('127.0.0.1', 9); return 'constructed' }" +
  " catch (error) { return 'threw:' + String(error && error.name) } })()"

async function probe() {
  const partition = 'persist:h3-egress-' + config.protectedSession + '-' + Date.now()
  const routeSession = session.fromPartition(partition, { cache: false })
  routeSession.setCertificateVerifyProc((_request, callback) => callback(0))
  await routeSession.setProxy(
    config.protectedSession
      ? {
          mode: 'fixed_servers',
          proxyRules: 'socks5://127.0.0.1:' + config.socksPort,
          proxyBypassRules: '<-loopback>'
        }
      : { mode: 'direct' }
  )
  await routeSession.closeAllConnections()
  const resolvedProxy = await routeSession.resolveProxy(
    'https://' + config.host + ':' + config.forcedQuicPort + '/'
  )
  routeSession.protocol.handle('probe', () =>
    new Response('<!doctype html><title>H3 egress probe</title>', {
      headers: { 'Content-Type': 'text/html' }
    })
  )
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true }
  })
  let rendererGone = 'none'
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererGone = String(details && details.reason)
  })
  await window.loadURL('probe://page/')

  const webTransport = await window.webContents.executeJavaScript(
    webTransportScript(config.host + ':' + config.webTransportPort)
  )
  // Allow late datagrams to arrive before starting the next probe.
  await settle(500)

  const directSockets = await window.webContents.executeJavaScript(DIRECT_SOCKETS_SCRIPT)

  const forcedQuic = await window.webContents.executeJavaScript(
    forcedQuicScript(config.host + ':' + config.forcedQuicPort)
  )
  await settle(500)

  // Run last because Direct Sockets kills the control renderer.
  const directSocketsConstruct = await Promise.race([
    window.webContents
      .executeJavaScript(DIRECT_SOCKETS_CONSTRUCT_SCRIPT)
      .catch((error) => 'call-failed:' + String(error && error.message)),
    settle(4000).then(() => 'no-answer')
  ])
  // Wait for asynchronous ReportBadMessage termination; the guarded arm must also finish.
  for (let attempt = 0; attempt < 30 && rendererGone === 'none'; attempt += 1) {
    await settle(100)
  }

  window.destroy()
  return { resolvedProxy, webTransport, directSockets, forcedQuic, directSocketsConstruct, rendererGone }
}

async function run() {
  const timeout = setTimeout(() => app.exit(2), 25000)
  await app.whenReady()
  const result = await probe()
  writeFileSync(config.resultPath, JSON.stringify(result))
  clearTimeout(timeout)
  app.quit()
}

run().catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error?.stack || error) }))
  app.exit(1)
})
`
}
