import { app, BaseWindow, BrowserWindow, protocol, ipcMain, session } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
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
import {
  activateBrowserExtensionAction,
  getBrowserExtensionToolbarState
} from './browser-extension-toolbar'
import {
  getOpenBrowserExtensionPopup,
  openBrowserExtensionPopup
} from './browser-extension-popup-host'

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
const reports = new Map<string, (value: unknown) => void>()
const reported = new Map<string, unknown>()

function writeStatus(): void {
  status.windowsHidden = BaseWindow.getAllWindows().every((window) => !window.isVisible())
  writeFileSync(`${fixtureStatusPath}.next`, JSON.stringify(status))
  renameSync(`${fixtureStatusPath}.next`, fixtureStatusPath)
}

function waitForReport(key: string): Promise<unknown> {
  if (reported.has(key)) {
    return Promise.resolve(reported.get(key))
  }
  return new Promise((resolve) => reports.set(key, resolve))
}

function captureResult(message: string): void {
  const match = /^ORCA_EXT_(\w+) (.*)$/s.exec(message)
  if (!match) {
    return
  }
  const key = match[1].toLowerCase()
  const value: unknown = JSON.parse(match[2])
  reported.set(key, value)
  status[key] = value
  reports.get(key)?.(value)
  writeStatus()
}

function fail(error: unknown): void {
  status.error = String(error instanceof Error ? error.stack : error)
  writeStatus()
  app.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

async function waitFor<T>(read: () => T | null, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the fixture condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

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

  // Orca's main window with two registered tabs; page-1 starts active.
  const host = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true }
  })
  trackBrowserExtensionMainWindow(host)
  status.hostWindowId = host.id
  // Stands in for the renderer's tab model: activation requests make the page active and reply.
  const send = host.webContents.send.bind(host.webContents)
  host.webContents.send = (channel: string, ...args: unknown[]) => {
    const [request] = args
    if (
      channel === 'browser:requestTabActivate' &&
      request &&
      typeof request === 'object' &&
      'requestId' in request &&
      'browserPageId' in request &&
      typeof request.browserPageId === 'string'
    ) {
      status.activationRequests = [
        ...(Array.isArray(status.activationRequests) ? status.activationRequests : []),
        request.browserPageId
      ]
      recordActiveBrowserPage(request.browserPageId)
      ipcMain.emit(
        'browser:tabActivateReply',
        { sender: host.webContents },
        {
          requestId: request.requestId
        }
      )
      return
    }
    send(channel, ...args)
  }
  const pageIds = ['page-1', 'page-2']
  const attached = new Promise<void>((resolve) => {
    let count = 0
    host.webContents.on('did-attach-webview', (_event, guest) => {
      const browserPageId = pageIds[count++]
      browserManager.attachGuestPolicies(guest)
      browserManager.registerGuest({
        browserPageId,
        webContentsId: guest.id,
        rendererWebContentsId: host.webContents.id
      })
      status[`${browserPageId}-tab`] = guest.id
      guest.once('did-finish-load', () => {
        if (count === pageIds.length) {
          resolve()
        }
      })
    })
  })
  const webview = `<webview partition="${ORCA_BROWSER_PARTITION}" src="data:text/html,<title>tab</title>" style="width:400px;height:300px"></webview>`
  await host.loadURL(`data:text/html,${encodeURIComponent(webview + webview)}`)
  await attached
  recordActiveBrowserPage('page-1')

  const added = await addUnpackedBrowserExtension(profile.id, fixtureExtensionDirectory)
  status.added = added
  writeStatus()
  await waitForReport('worker')

  const toolbar = await getBrowserExtensionToolbarState('page-1')
  const extensionId = toolbar?.actions[0]?.extensionId ?? ''
  status.toolbar = toolbar
  status.otherTabToolbar = await getBrowserExtensionToolbarState('page-2')
  status.untrackedPage = await getBrowserExtensionToolbarState('no-such-page')

  // A click under a button at (300, 10) opens the popup at the page's preferred size.
  recordActiveBrowserPage('page-1')
  const anchor = { x: 300, y: 10, width: 28, height: 28 }
  status.firstClick = activateBrowserExtensionAction({
    browserPageId: 'page-1',
    extensionId,
    anchor,
    popupOnly: false
  })
  const popupWindow = await waitFor(() => {
    const popup = BrowserWindow.getAllWindows().find(
      (window) => window.getParentWindow() === host && window.webContents.getURL().includes('popup')
    )
    return popup && popup.getBounds().width === 320 ? popup : null
  })
  await waitForReport('popup')
  const bounds = popupWindow.getBounds()
  const content = host.getContentBounds()
  status.popupBounds = {
    width: bounds.width,
    height: bounds.height,
    rightAligned: bounds.x + bounds.width === content.x + anchor.x + anchor.width,
    below: bounds.y >= content.y + anchor.y + anchor.height
  }
  // A second click on the same button closes it.
  status.secondClick = activateBrowserExtensionAction({
    browserPageId: 'page-1',
    extensionId,
    anchor,
    popupOnly: false
  })
  status.openAfterSecondClick = getOpenBrowserExtensionPopup()

  // A popup whose content renders after load (as React popups do) resizes to it while hidden.
  const late = openBrowserExtensionPopup({
    session: extensionSession,
    profileId: profile.id,
    extensionId,
    popupPath: 'late.html',
    anchor,
    openTab: () => {}
  })
  status.latePopupBounds = await waitFor(() => {
    const { width, height } = late.getBounds()
    return width === 300 && height === 180 ? { width, height } : null
  })
  // A page without a doctype (quirks mode) still gets its content's height, not the window's.
  const quirks = openBrowserExtensionPopup({
    session: extensionSession,
    profileId: profile.id,
    extensionId,
    popupPath: 'quirks.html',
    anchor,
    openTab: () => {}
  })
  status.quirksPopupBounds = await waitFor(() => {
    const { width, height } = quirks.getBounds()
    return width === 170 ? { width, height } : null
  })
  status.done = true
  writeStatus()
}

void run().catch(fail)
