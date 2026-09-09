export function persistedWorkerElectronMain(): string {
  return String.raw`
const { app, BrowserWindow, session } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const mode = process.argv[3]
const partition = 'persist:worker-egress'
const scope = 'http://localhost:' + config.targetPort + '/'

async function waitForContinue() {
  const deadline = Date.now() + 10000
  while (!existsSync(config.continuePath)) {
    if (Date.now() >= deadline) throw new Error('worker_probe_continue_barrier_missing')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function setup() {
  const routeSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true } })
  await window.loadURL(scope)
  await window.webContents.executeJavaScript("navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => true)")
  window.destroy()
  return { registered: true }
}

async function probe() {
  const routeSession = session.fromPartition(partition)
  const workerRunningBeforeForcedWake = Object.keys(routeSession.serviceWorkers.getAllRunning()).length > 0
  const proxySetup = config.protectedSession
    ? routeSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:' + config.socksPort, proxyBypassRules: '<-loopback>' })
    : null
  await routeSession.serviceWorkers.startWorkerForScope(scope)
  writeFileSync(config.workerStartedPath, '')
  await waitForContinue()
  await (proxySetup ?? routeSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:' + config.socksPort, proxyBypassRules: '<-loopback>' }))
  await routeSession.closeAllConnections()
  const resolvedProxy = await routeSession.resolveProxy(scope)
  const window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true } })
  await window.loadURL(scope)
  await window.webContents.executeJavaScript("new Promise(async (resolve, reject) => { const registration = await navigator.serviceWorker.ready; const worker = navigator.serviceWorker.controller || registration.active; const timeout = setTimeout(() => reject(new Error('worker message timeout')), 5000); navigator.serviceWorker.addEventListener('message', event => { if (event.data === 'done') { clearTimeout(timeout); resolve(true) } }, { once: true }); worker.postMessage('probe') })")
  window.destroy()
  return { resolvedProxy, workerRunningBeforeForcedWake }
}

async function run() {
  const timeout = setTimeout(() => app.exit(2), 20000)
  await app.whenReady()
  const result = mode === 'setup' ? await setup() : await probe()
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
