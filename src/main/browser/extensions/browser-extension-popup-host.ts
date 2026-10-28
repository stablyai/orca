import { BrowserWindow, screen } from 'electron'
import type { BrowserExtensionAnchorRect } from '../../../shared/browser-extension-toolbar-types'
import {
  getChromeExtensionOrigin,
  isSameExtensionNavigation
} from '../../../shared/browser-extension-url'
import { BrowserExtensionApiError } from './browser-extension-namespace-registry'
import {
  BROWSER_EXTENSION_POPUP_MAX,
  anchorToScreen,
  clampBrowserExtensionPopupSize,
  placeBrowserExtensionPopup
} from './browser-extension-popup-geometry'
import { watchBrowserExtensionPopupSize } from './browser-extension-popup-size-watch'
import {
  getBrowserExtensionMainWindow,
  presentBrowserExtensionWindow
} from './browser-extension-window-model'

type OpenPopup = {
  window: BrowserWindow
  profileId: string
  extensionId: string
}

/**
 * Why remember blur closes: clicking the button of an open popup blurs (and closes) the popup
 * before the click lands, which would reopen it; Chrome treats that click as "close".
 */
const TOGGLE_AFTER_BLUR_MS = 400

let current: OpenPopup | null = null
let lastBlurClose: { profileId: string; extensionId: string; at: number } | null = null

export function getOpenBrowserExtensionPopup(): { profileId: string; extensionId: string } | null {
  return current && !current.window.isDestroyed()
    ? { profileId: current.profileId, extensionId: current.extensionId }
    : null
}

export function closeBrowserExtensionPopup(): void {
  const popup = current
  current = null
  if (popup && !popup.window.isDestroyed()) {
    popup.window.close()
  }
}

/** True when this click should only close the popup it just closed or still shows. */
export function consumeBrowserExtensionPopupToggle(
  profileId: string,
  extensionId: string
): boolean {
  const open = getOpenBrowserExtensionPopup()
  if (open?.profileId === profileId && open.extensionId === extensionId) {
    closeBrowserExtensionPopup()
    return true
  }
  const recent = lastBlurClose
  lastBlurClose = null
  return (
    recent !== null &&
    recent.profileId === profileId &&
    recent.extensionId === extensionId &&
    Date.now() - recent.at < TOGGLE_AFTER_BLUR_MS
  )
}

export type BrowserExtensionPopupOptions = {
  session: Electron.Session
  profileId: string
  extensionId: string
  /** Relative to the extension root, as manifest/action.setPopup give it. */
  popupPath: string
  anchor: BrowserExtensionAnchorRect
  /** Web links the popup opens with target=_blank go to a new Orca tab. */
  openTab: (url: string) => void
}

function popupUrl(extensionId: string, popupPath: string): string {
  const url = new URL(popupPath.replace(/^\/+/, ''), `${getChromeExtensionOrigin(extensionId)}/`)
  if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId) {
    throw new BrowserExtensionApiError('The popup must be a page of the extension')
  }
  return url.toString()
}

/**
 * The action popup: a frameless child of Orca's window under the clicked button, loaded in the
 * extension's profile session (whose preload gives it the extension APIs). It follows its content's
 * size within Chrome's limits and closes on blur, Escape or a second click.
 */
export function openBrowserExtensionPopup(options: BrowserExtensionPopupOptions): BrowserWindow {
  const mainWindow = getBrowserExtensionMainWindow()
  if (!mainWindow) {
    throw new BrowserExtensionApiError('Orca has no window to show the popup in')
  }
  const url = popupUrl(options.extensionId, options.popupPath)
  closeBrowserExtensionPopup()
  const anchor = anchorToScreen(
    options.anchor,
    mainWindow.getContentBounds(),
    mainWindow.webContents.getZoomFactor()
  )
  const workArea = screen.getDisplayMatching(anchor).workArea
  // Why start at the maximum: a page lays out (and sizes itself, as Bitwarden does from
  // innerHeight) at the size its window was created with, like Chrome's popup before it shrinks.
  const initial = placeBrowserExtensionPopup(anchor, BROWSER_EXTENSION_POPUP_MAX, workArea)
  const window = new BrowserWindow({
    ...initial,
    parent: mainWindow,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      session: options.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Why: framed extension pages need Orca's preload (safety: main-window-webview-security.ts).
      nodeIntegrationInSubFrames: true,
      webSecurity: true
    }
  })
  const popup: OpenPopup = {
    window,
    profileId: options.profileId,
    extensionId: options.extensionId
  }
  current = popup
  const contents = window.webContents

  // Why measure in the page: preferred-size-changed only reports while the window paints, and its
  // height never drops below the viewport, so a hidden or late-rendering popup kept its first size.
  let watchGeneration = 0
  let presented = false
  const watchSize = (): Promise<void> => {
    const generation = ++watchGeneration
    return watchBrowserExtensionPopupSize(
      contents,
      () => generation === watchGeneration && !window.isDestroyed(),
      (size) =>
        window.setBounds(
          placeBrowserExtensionPopup(anchor, clampBrowserExtensionPopupSize(size), workArea)
        )
    )
  }
  contents.on('did-navigate', () => {
    if (presented) {
      void watchSize()
    }
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      closeBrowserExtensionPopup()
    }
  })
  contents.setWindowOpenHandler(({ url: target }) => {
    options.openTab(target)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, target) => {
    if (!isSameExtensionNavigation(contents.getURL(), target)) {
      event.preventDefault()
    }
  })
  window.on('blur', () => {
    if (current === popup) {
      lastBlurClose = { profileId: popup.profileId, extensionId: popup.extensionId, at: Date.now() }
      closeBrowserExtensionPopup()
    }
  })
  window.once('closed', () => {
    if (current === popup) {
      current = null
    }
  })
  window.once('ready-to-show', () => {
    void watchSize().then(() => {
      if (!window.isDestroyed()) {
        presented = true
        presentBrowserExtensionWindow(window, true)
      }
    })
  })
  window.loadURL(url).catch((error: unknown) => {
    console.warn('[browser-extensions] Popup failed to load:', error)
  })
  return window
}
