import { app, BaseWindow, BrowserWindow, protocol, session } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import { applyBackgroundActivationPolicy } from '../../window/foreground-activation-policy'
import { browserManager } from '../browser-manager'
import { browserSessionRegistry } from '../browser-session-registry'
import { initializeBrowserExtensionSupport } from './browser-extension-startup'
import { BROWSER_EXTENSION_API_CUSTOM_SCHEME } from './browser-extension-api-scheme'
import {
  attachBrowserExtensionsToProfileSession,
  whenBrowserExtensionSessionsLoaded
} from './browser-extension-session-loader'
import { addUnpackedBrowserExtension } from './browser-extension-management'
import { buildBrowserExtensionPageContextMenu } from './browser-extension-context-menu-host'
import { recordActiveBrowserPage } from './browser-extension-tab-model'
import { trackBrowserExtensionMainWindow } from './browser-extension-window-model'

const statusPath = process.env.ORCA_EXTENSION_FIXTURE_STATUS
const extensionDirectory = process.env.ORCA_EXTENSION_FIXTURE_DIR
const phase = process.env.ORCA_EXTENSION_FIXTURE_PHASE
if (
  !statusPath ||
  !extensionDirectory ||
  (phase !== 'first' && phase !== 'second') ||
  process.env.ORCA_BACKGROUND_LAUNCH !== '1'
) {
  throw new Error(
    'Persistence fixture requires a status path, an extension, a phase and background launch'
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

function writeStatus(): void {
  status.windowsHidden = BaseWindow.getAllWindows().every((window) => !window.isVisible())
  writeFileSync(`${fixtureStatusPath}.next`, JSON.stringify(status))
  renameSync(`${fixtureStatusPath}.next`, fixtureStatusPath)
}

function fail(error: unknown): void {
  status.error = String(error)
  writeStatus()
  app.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

function capture(message: string): void {
  for (const [prefix, key] of [
    ['ORCA_EXT_SETUP ', 'setup'],
    ['ORCA_EXT_WEBREQUEST ', 'webRequest'],
    ['ORCA_EXT_CONTENT_SCRIPT ', 'contentScript'],
    ['ORCA_EXT_COMMAND ', 'commands'],
    ['ORCA_EXT_SYNC ', 'sync']
  ] as const) {
    if (message.startsWith(prefix)) {
      const value: unknown = JSON.parse(message.slice(prefix.length))
      status[key] =
        key === 'commands' ? [...(Array.isArray(status[key]) ? status[key] : []), value] : value
      writeStatus()
      // Why quit, not exit: will-quit flushes the extension state the second launch replays.
      if (key === 'setup' && phase === 'first') {
        setTimeout(() => app.quit(), 300)
      }
    }
  }
}

/** Orca's main window with one registered tab on `url`, made active the way the renderer does. */
async function openTab(url: string): Promise<Electron.WebContents> {
  const host = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true }
  })
  trackBrowserExtensionMainWindow(host)
  const attached = new Promise<Electron.WebContents>((resolve) => {
    host.webContents.once('did-attach-webview', (_event, guest) => {
      guest.on('console-message', (details) => capture(details.message))
      browserManager.attachGuestPolicies(guest)
      browserManager.registerGuest({
        browserPageId: 'page-1',
        webContentsId: guest.id,
        rendererWebContentsId: host.webContents.id
      })
      recordActiveBrowserPage('page-1')
      guest.once('did-finish-load', () => resolve(guest))
    })
  })
  await host.loadURL(
    `data:text/html,${encodeURIComponent(
      `<webview partition="${ORCA_BROWSER_PARTITION}" src="${url}"></webview>`
    )}`
  )
  return attached
}

async function run(): Promise<void> {
  await app.whenReady()
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>page</title><input id="field">')
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const pageUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/login`

  initializeBrowserExtensionSupport({ enabled: true })
  const profile = browserSessionRegistry.getDefaultProfile()
  session
    .fromPartition(ORCA_BROWSER_PARTITION)
    .serviceWorkers.on('console-message', (_event, details) => capture(details.message))

  if (phase === 'first') {
    attachBrowserExtensionsToProfileSession(profile, [])
    status.added = await addUnpackedBrowserExtension(profile.id, fixtureExtensionDirectory)
    writeStatus()
    return
  }

  // Second launch: what a restart does, then the first page load.
  attachBrowserExtensionsToProfileSession(
    profile,
    browserSessionRegistry.getEnabledExtensionIds(profile.id)
  )
  await whenBrowserExtensionSessionsLoaded(5_000)
  const guest = await openTab(pageUrl)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only the fields given here.
  const params = {
    isEditable: true,
    mediaType: 'none',
    frame: null,
    selectionText: ''
  } as unknown as Electron.ContextMenuParams
  status.menu = buildBrowserExtensionPageContextMenu(guest, params)?.groups ?? null
  writeStatus()
  // An extension command, then one Orca owns (Mod+Shift+F), typed into the tab.
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  for (const keyCode of ['L', 'F']) {
    guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [mod, 'shift'] })
    guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [mod, 'shift'] })
  }
}

app.on('will-quit', () => writeStatus())
void run().catch(fail)
