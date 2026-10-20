/// <reference types="chrome" />
import { BrowserWindow } from 'electron'
import { normalizeBrowserNavigationUrl } from '../../../shared/browser-url'
import { isSameExtensionNavigation } from '../../../shared/browser-extension-url'
import {
  isBackgroundLaunch,
  showWindowWithoutStealingFocus
} from '../../window/foreground-activation-policy'
import { emitBrowserExtensionEvent } from './browser-extension-api-host'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import { watchBrowserExtensionMainWindowReadiness } from './browser-extension-main-window-readiness'

/** chrome.windows constants. */
export const WINDOW_ID_NONE = -1
export const WINDOW_ID_CURRENT = -2

export type BrowserExtensionWindowEntry = {
  window: BrowserWindow
  type: 'normal' | 'popup'
  /** Orca's own window: every browser tab lives here and extensions may not close it. */
  isMain: boolean
}

type PopoutState = { window: BrowserWindow; session: Electron.Session; type: 'normal' | 'popup' }

let mainWindow: BrowserWindow | null = null
let lastFocusedWindowId: number | null = null
const popoutsByWindowId = new Map<number, PopoutState>()
const watchedWindows = new WeakSet<BrowserWindow>()
const BOUNDS_EVENT_DELAY_MS = 150

function isOrcaWindowFocused(): boolean {
  return (
    Boolean(mainWindow?.isFocused()) ||
    [...popoutsByWindowId.values()].some((p) => p.window.isFocused())
  )
}

// Why one closed listener per window: Orca's core already puts ~9 on the main window, so extras trip Node's leak warning.
function watchWindowEvents(window: BrowserWindow, onClosed?: () => void): void {
  if (watchedWindows.has(window)) {
    return
  }
  watchedWindows.add(window)
  const windowId = window.id
  let boundsTimer: NodeJS.Timeout | undefined
  const emitBounds = (): void => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      const entry = getBrowserExtensionWindow(windowId)
      if (entry) {
        emitBrowserExtensionEvent({}, 'windows', 'onBoundsChanged', [
          describeBrowserExtensionWindow(entry)
        ])
      }
    }, BOUNDS_EVENT_DELAY_MS)
  }
  window.on('focus', () => {
    lastFocusedWindowId = windowId
    emitBrowserExtensionEvent({}, 'windows', 'onFocusChanged', [windowId])
  })
  window.on('blur', () => {
    setImmediate(() => {
      if (!isOrcaWindowFocused()) {
        emitBrowserExtensionEvent({}, 'windows', 'onFocusChanged', [WINDOW_ID_NONE])
      }
    })
  })
  window.on('resize', emitBounds)
  window.on('move', emitBounds)
  window.once('closed', () => {
    clearTimeout(boundsTimer)
    onClosed?.()
  })
}

/** Called when Orca creates its main window; tabs.* and windows.* answer relative to it. */
export function trackBrowserExtensionMainWindow(window: BrowserWindow): void {
  if (!isBrowserExtensionSupportEnabled()) {
    return
  }
  mainWindow = window
  watchBrowserExtensionMainWindowReadiness(window)
  watchWindowEvents(window, () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
}

export function getBrowserExtensionMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function getBrowserExtensionWindow(windowId: number): BrowserExtensionWindowEntry | null {
  const main = getBrowserExtensionMainWindow()
  if (main && main.id === windowId) {
    return { window: main, type: 'normal', isMain: true }
  }
  const popout = popoutsByWindowId.get(windowId)
  return popout && !popout.window.isDestroyed()
    ? { window: popout.window, type: popout.type, isMain: false }
    : null
}

export function listBrowserExtensionWindows(): BrowserExtensionWindowEntry[] {
  const ids = [getBrowserExtensionMainWindow()?.id, ...popoutsByWindowId.keys()]
  return ids.flatMap((id) => {
    const entry = id === undefined ? null : getBrowserExtensionWindow(id)
    return entry ? [entry] : []
  })
}

/** The popout whose page is this webContents (its one tab), if any. */
export function getPopoutWindowForWebContents(
  contents: Electron.WebContents
): BrowserWindow | null {
  for (const popout of popoutsByWindowId.values()) {
    if (!popout.window.isDestroyed() && popout.window.webContents === contents) {
      return popout.window
    }
  }
  return null
}

export function listPopoutWindowsInSession(sess: Electron.Session): BrowserWindow[] {
  return [...popoutsByWindowId.values()]
    .filter((popout) => popout.session === sess && !popout.window.isDestroyed())
    .map((popout) => popout.window)
}

export function getLastFocusedBrowserExtensionWindowId(): number | null {
  if (lastFocusedWindowId !== null && getBrowserExtensionWindow(lastFocusedWindowId)) {
    return lastFocusedWindowId
  }
  return getBrowserExtensionMainWindow()?.id ?? null
}

export function describeBrowserExtensionWindow(
  entry: BrowserExtensionWindowEntry,
  tabs?: chrome.tabs.Tab[]
): chrome.windows.Window {
  const { window } = entry
  const bounds = window.getBounds()
  const state = window.isMinimized()
    ? 'minimized'
    : window.isFullScreen()
      ? 'fullscreen'
      : window.isMaximized()
        ? 'maximized'
        : 'normal'
  return {
    id: window.id,
    focused: window.isFocused(),
    top: bounds.y,
    left: bounds.x,
    width: bounds.width,
    height: bounds.height,
    incognito: false,
    type: entry.type,
    state,
    alwaysOnTop: window.isAlwaysOnTop(),
    ...(tabs ? { tabs } : {})
  }
}

/** Focus or reveal per Orca's launch policy; automated (background) runs never take the foreground. */
export function presentBrowserExtensionWindow(window: BrowserWindow, focused: boolean): void {
  if (focused && !isBackgroundLaunch()) {
    window.show()
    window.focus()
    return
  }
  showWindowWithoutStealingFocus(window)
}

export type BrowserExtensionPopoutOptions = {
  url: string
  type: 'normal' | 'popup'
  left?: number
  top?: number
  width?: number
  height?: number
  focused: boolean
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen'
}

/** windows.create: a real window in the extension's session, with its own id. */
export function createBrowserExtensionPopout(
  sess: Electron.Session,
  options: BrowserExtensionPopoutOptions
): BrowserWindow {
  const window = new BrowserWindow({
    x: options.left,
    y: options.top,
    width: options.width ?? 420,
    height: options.height ?? 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: sess,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Why: framed extension pages need Orca's preload (safety: main-window-webview-security.ts).
      nodeIntegrationInSubFrames: true,
      webSecurity: true
    }
  })
  popoutsByWindowId.set(window.id, { window, session: sess, type: options.type })
  const windowId = window.id
  watchWindowEvents(window, () => {
    popoutsByWindowId.delete(windowId)
    emitBrowserExtensionEvent({}, 'windows', 'onRemoved', [windowId])
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Why: the popout gets no Orca guest policies, so it may only move within its extension or to web URLs.
  window.webContents.on('will-navigate', (event, url) => {
    const isWeb = /^https?:/i.test(url) && normalizeBrowserNavigationUrl(url) !== null
    if (!isWeb && !isSameExtensionNavigation(window.webContents.getURL(), url)) {
      event.preventDefault()
    }
  })
  window.once('ready-to-show', () => {
    if (options.state === 'maximized') {
      window.maximize()
    } else if (options.state === 'fullscreen') {
      window.setFullScreen(true)
    }
    if (options.state === 'minimized') {
      window.minimize()
      return
    }
    presentBrowserExtensionWindow(window, options.focused)
  })
  window.loadURL(options.url).catch((error: unknown) => {
    console.warn('[browser-extensions] Popout failed to load:', error)
  })
  emitBrowserExtensionEvent({}, 'windows', 'onCreated', [
    describeBrowserExtensionWindow({ window, type: options.type, isMain: false })
  ])
  return window
}
