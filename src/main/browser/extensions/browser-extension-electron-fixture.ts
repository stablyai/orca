import { app, BaseWindow, BrowserWindow, protocol, session, webContents } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import { applyBackgroundActivationPolicy } from '../../window/foreground-activation-policy'
import { browserManager } from '../browser-manager'
import { browserSessionRegistry } from '../browser-session-registry'
import { initializeBrowserExtensionSupport } from './browser-extension-startup'
import { BROWSER_EXTENSION_API_CUSTOM_SCHEME } from './browser-extension-api-scheme'
import { attachBrowserExtensionsToProfileSession } from './browser-extension-session-loader'
import { addUnpackedBrowserExtension } from './browser-extension-management'
import { recordActiveBrowserPage } from './browser-extension-tab-model'
import { trackBrowserExtensionMainWindow } from './browser-extension-window-model'

const statusPath = process.env.ORCA_EXTENSION_FIXTURE_STATUS
const extensionDirectory = process.env.ORCA_EXTENSION_FIXTURE_DIR
if (!statusPath || !extensionDirectory || process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error(
    'Extension fixture requires a status path, an extension folder and background launch'
  )
}
const fixtureStatusPath = statusPath
const fixtureExtensionDirectory = extensionDirectory

// Orca's preflight registers this before ready; the worker shim calls main through it.
protocol.registerSchemesAsPrivileged([BROWSER_EXTENSION_API_CUSTOM_SCHEME])

const presentationCalls: string[] = []
for (const method of ['show', 'showInactive', 'focus', 'moveTop'] as const) {
  BaseWindow.prototype[method] = () => {
    presentationCalls.push(method)
  }
}
app.focus = () => {
  presentationCalls.push('app.focus')
}
applyBackgroundActivationPolicy()

const status: Record<string, unknown> = { presentationCalls }
let popoutWindowId: number | null = null

function writeStatus(): void {
  status.windowsHidden = BaseWindow.getAllWindows().every((window) => !window.isVisible())
  if (popoutWindowId !== null) {
    status.popoutContentsId = BrowserWindow.fromId(popoutWindowId)?.webContents.id ?? null
  }
  writeFileSync(`${fixtureStatusPath}.next`, JSON.stringify(status))
  renameSync(`${fixtureStatusPath}.next`, fixtureStatusPath)
}

function captureResult(message: string): void {
  for (const [prefix, key] of [
    ['ORCA_EXT_WORKER ', 'worker'],
    ['ORCA_EXT_PAGE ', 'page'],
    ['ORCA_EXT_STORAGE ', 'storage'],
    ['ORCA_EXT_SYNC_WORKER ', 'syncWorker'],
    ['ORCA_EXT_SYNC_PAGE ', 'syncPage'],
    ['ORCA_EXT_SYNC_CONTENT ', 'syncContent'],
    ['ORCA_EXT_CONTENT_APIS ', 'contentApis'],
    ['ORCA_EXT_FRAME ', 'frame'],
    ['ORCA_EXT_WEB_FRAME ', 'webFrame'],
    ['ORCA_EXT_SANDBOX ', 'sandbox']
  ] as const) {
    if (message.startsWith(prefix)) {
      const result: unknown = JSON.parse(message.slice(prefix.length))
      status[key] = result
      if (
        result &&
        typeof result === 'object' &&
        'popout' in result &&
        typeof result.popout === 'number'
      ) {
        popoutWindowId = result.popout
      }
      writeStatus()
    }
  }
}

process.on('uncaughtException', (error) => {
  status.error = String(error)
  writeStatus()
  app.exit(1)
})
process.on('unhandledRejection', (error) => {
  status.error = String(error)
  writeStatus()
  app.exit(1)
})

async function run(): Promise<void> {
  await app.whenReady()
  initializeBrowserExtensionSupport({ enabled: true })
  const profile = browserSessionRegistry.getDefaultProfile()
  attachBrowserExtensionsToProfileSession(profile, [])
  const extensionSession = session.fromPartition(ORCA_BROWSER_PARTITION)
  extensionSession.serviceWorkers.on('console-message', (_event, details) =>
    captureResult(details.message)
  )
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (details) => captureResult(details.message))
  })

  // Orca's main window with one registered browser tab, made active the way the renderer does.
  const host = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true }
  })
  trackBrowserExtensionMainWindow(host)
  status.hostWindowId = host.id
  const attached = new Promise<void>((resolve) => {
    host.webContents.once('did-attach-webview', (_event, guest) => {
      browserManager.attachGuestPolicies(guest)
      browserManager.registerGuest({
        browserPageId: 'page-1',
        webContentsId: guest.id,
        rendererWebContentsId: host.webContents.id
      })
      recordActiveBrowserPage('page-1')
      status.guestId = guest.id
      guest.once('did-finish-load', () => resolve())
    })
  })
  await host.loadURL(
    `data:text/html,${encodeURIComponent(
      `<webview partition="${ORCA_BROWSER_PARTITION}" src="data:text/html,<title>tab</title>"></webview>`
    )}`
  )
  await attached

  const added = await addUnpackedBrowserExtension(profile.id, fixtureExtensionDirectory)
  status.added = added
  writeStatus()

  // A page can reach the scheme but has no token, so main must refuse it.
  const guest = webContents.fromId(Number(status.guestId))
  const extensionId = extensionSession.extensions.getAllExtensions()[0]?.id
  const sandboxPage = new BrowserWindow({
    show: false,
    webPreferences: { partition: ORCA_BROWSER_PARTITION, sandbox: true }
  })
  void sandboxPage.loadURL(`chrome-extension://${extensionId}/sandboxed.html`)
  status.webPageCall = await guest?.executeJavaScript(
    `fetch('orca-extension-api://api/call', { method: 'POST', body: JSON.stringify({ token: 'guess', request: { type: 'call', namespace: 'windows', method: 'getAll', args: [] } }) }).then((r) => r.status, () => 'failed')`
  )
  writeStatus()

  // A web page the extension's content script runs in, once the worker and page are done with sync.
  while (!status.syncWorker || !status.syncPage) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>web page</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  // Subframe preloads as Orca's browser guests get them in a profile that runs extensions.
  const webPage = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: ORCA_BROWSER_PARTITION,
      sandbox: true,
      nodeIntegrationInSubFrames: true
    }
  })
  await webPage.loadURL(`http://127.0.0.1:${port}/`).catch((error: unknown) => {
    status.syncContent = { error: String(error) }
    writeStatus()
  })
}

void run().catch((error: unknown) => {
  status.error = String(error)
  writeStatus()
  app.exit(1)
})
