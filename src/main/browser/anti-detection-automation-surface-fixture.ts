import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import { runBrowserRouteEgressElectron } from './browser-route-egress-electron-launch'

/** One reading of the automation surface a detector can see from inside a browser guest. */
export type AutomationSurface = {
  webdriverValue: unknown
  /** Chrome keeps `webdriver` on Navigator.prototype; an own property is a tamper signal. */
  webdriverOwnProperty: boolean
  webdriverOnPrototype: boolean
  pluginsLength: number
  pluginsIsPluginArray: boolean
  languagesLength: number
  topFrameChrome: string
  subframeChrome: string
  /** bot.sannysoft.com: `navigator.webdriver || _.has(navigator, 'webdriver')`. */
  sannysoftWebdriverFailed: boolean
  /** bot.sannysoft.com: not a PluginArray, empty, or a first entry that is not a Plugin. */
  sannysoftPluginsTypeFailed: boolean
  /** bot.sannysoft.com: no window.chrome at all. */
  sannysoftChromeFailed: boolean
  /** bot.sannysoft.com: no navigator.languages entries. */
  sannysoftLanguagesFailed: boolean
}

export type AntiDetectionAutomationSurfaceProbeResult = {
  /** No debugger attached and no script: what the guest exposes on its own. */
  native: AutomationSurface
  /** webContents.debugger attached, nothing injected: isolates what CDP attachment alone changes. */
  debuggerAttached: AutomationSurface
  /** The production injection path: attach, then Page.addScriptToEvaluateOnNewDocument. */
  scriptInjected: AutomationSurface
}

const MEASURE_SOURCE = `(() => {
  const iframe = document.createElement('iframe')
  iframe.srcdoc = 'subframe'
  document.body.appendChild(iframe)
  const subframeChrome = typeof iframe.contentWindow.chrome
  iframe.remove()
  const plugins = navigator.plugins
  const webdriverOwnProperty = Object.prototype.hasOwnProperty.call(navigator, 'webdriver')
  const pluginsIsPluginArray = plugins instanceof PluginArray
  return {
    webdriverValue: navigator.webdriver,
    webdriverOwnProperty,
    webdriverOnPrototype:
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver') !== undefined,
    pluginsLength: plugins.length,
    pluginsIsPluginArray,
    languagesLength: (navigator.languages || []).length,
    topFrameChrome: typeof window.chrome,
    subframeChrome,
    sannysoftWebdriverFailed: Boolean(navigator.webdriver) || webdriverOwnProperty,
    sannysoftPluginsTypeFailed:
      !pluginsIsPluginArray || plugins.length === 0 || String(plugins[0]) !== '[object Plugin]',
    sannysoftChromeFailed: !window.chrome,
    sannysoftLanguagesFailed: !navigator.languages || navigator.languages.length === 0
  }
})()`

/**
 * Reads the automation surface of a real Electron `<webview>` guest in three states, so a claim
 * about what the engine exposes can be checked instead of assumed.
 */
export async function runAntiDetectionAutomationSurfaceProbe(): Promise<AntiDetectionAutomationSurfaceProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-anti-detection-surface-'))
  try {
    const guestPath = join(root, 'guest.html')
    const hostPath = join(root, 'host.html')
    const mainPath = join(root, 'main.cjs')
    writeFileSync(guestPath, '<!doctype html><html><body>guest</body></html>')
    writeFileSync(
      hostPath,
      `<!doctype html><html><body><webview id="guest" src="${pathToFileURL(guestPath).href}" partition="persist:orca-anti-detection-surface" style="width:320px;height:240px"></webview></body></html>`
    )
    writeFileSync(mainPath, probeElectronMain())
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        hostPath,
        measureSource: MEASURE_SOURCE,
        resultPath: join(root, 'result.json'),
        script: ANTI_DETECTION_SCRIPT
      })
    )
    const parsed = await runBrowserRouteEgressElectron(root, mainPath)
    return parsed as unknown as AntiDetectionAutomationSurfaceProbeResult
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function probeElectronMain(): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const PARTITION = 'persist:orca-anti-detection-surface'

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + label))
      setTimeout(tick, 25)
    }
    tick()
  })
}

// Why the document and not guest.getURL(): a path the URL builder mis-encodes lands the guest on
// chrome-error://chromewebdata, whose engine readings look exactly like a healthy guest's — and
// whose requested URL still ends in guest.html. Only the loaded body proves what was measured.
async function measure(guest, config, label) {
  const loaded = await guest.executeJavaScript('[location.href, document.body && document.body.textContent]')
  if (loaded[1] !== 'guest') {
    throw new Error(label + ' measured ' + loaded[0] + ' instead of the guest document')
  }
  return guest.executeJavaScript(config.measureSource)
}

function reload(guest) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guest reload timed out')), 10000)
    guest.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
    guest.reload()
  })
}

async function run() {
  await app.whenReady()
  // Match the browser session policy: nothing is granted for this probe's partition.
  const sess = session.fromPartition(PARTITION)
  sess.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  sess.setPermissionCheckHandler(() => false)

  const host = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })
  let guest = null
  host.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.sandbox = true
    webPreferences.partition = PARTITION
  })
  host.webContents.on('did-attach-webview', (_event, attached) => {
    guest = attached
  })
  await host.loadFile(config.hostPath)
  // Why the URL and not just isLoading(): an attached guest reads as idle in the gap before its
  // src starts loading, and measuring there would read an empty document instead of the guest.
  await waitFor(
    () => guest !== null && !guest.isLoading() && guest.getURL().endsWith('guest.html'),
    'the guest webview to load its document'
  )

  const out = {}
  out.native = await measure(guest, config, 'native')

  guest.debugger.attach('1.3')
  await guest.debugger.sendCommand('Page.enable', {})
  await reload(guest)
  out.debuggerAttached = await measure(guest, config, 'debuggerAttached')

  await guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: config.script
  })
  await reload(guest)
  out.scriptInjected = await measure(guest, config, 'scriptInjected')

  writeFileSync(config.resultPath, JSON.stringify(out))
  app.exit(0)
}

run().catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String((error && error.stack) || error) }))
  app.exit(1)
})
`
}
