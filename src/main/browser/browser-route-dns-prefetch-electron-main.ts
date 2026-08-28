export function browserRouteDnsPrefetchElectronMain(): string {
  return String.raw`
const { app, BrowserWindow, protocol, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))

protocol.registerSchemesAsPrivileged([
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function settle(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function probe() {
  const partition = 'persist:dns-prefetch-' + Date.now()
  const routeSession = session.fromPartition(partition, { cache: false })
  await routeSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:' + config.socksPort,
    proxyBypassRules: '<-loopback>'
  })
  await routeSession.closeAllConnections()
  const resolvedProxy = await routeSession.resolveProxy('https://' + config.probeHost + '/')
  routeSession.protocol.handle('probe', () =>
    new Response(
      '<!doctype html><title>DNS prefetch probe</title>' +
        '<link rel="dns-prefetch" href="https://' + config.probeHost + '">',
      { headers: { 'Content-Type': 'text/html' } }
    )
  )

  await routeSession.netLog.startLogging(config.netLogPath)
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true }
  })
  await window.loadURL('probe://page/')
  // Why: PrefetchDNS is fire-and-forget with no page-visible completion, so the resolver needs time to log a job.
  await settle(4000)
  window.destroy()
  await routeSession.netLog.stopLogging()
  return { resolvedProxy }
}

// Why: destroying the probe window awaits stopLogging, which yields long enough for the default
// window-all-closed quit (non-macOS) to exit 0 before the result is written.
app.on('window-all-closed', () => {})

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
