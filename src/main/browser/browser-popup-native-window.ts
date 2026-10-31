import { app, type BrowserWindow, type WebContents } from 'electron'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import type { PopupChildWindowOptions, PopupOriginBarWindow } from './popup-origin-bar-window'
import {
  isNativeBrowserPopupWindow,
  markNativeBrowserPopupWindow
} from './native-browser-popup-windows'
import { MIN_POPUP_CONTENT_HEIGHT, MIN_POPUP_CONTENT_WIDTH } from './popup-window-minimum-size'
import { describeCommittedPopupOrigin } from './popup-committed-origin'
import { attachNativePopupQuitNotice } from './popup-hold-quit-notice'

const rejectedNativePopups = new WeakSet<BrowserWindow>()
// The latest script admission belongs to the next child the opener shows.
const pendingScriptedNativePopups = new WeakMap<
  WebContents,
  ((window: BrowserWindow) => void) | null
>()

/** Chromium's OpenURL path has no adoptable contents or public navigation callback. */
export function isNativeBrowserPopupRequest(input: {
  disposition?: string
  features?: string
  frameName?: string
}): boolean {
  return (
    (input.disposition === 'new-window' || input.disposition === 'background-tab') &&
    input.features === '' &&
    input.frameName === ''
  )
}

// OpenURL creates synchronously; scripted window.open creates its child in a later task.
export function allowNativeBrowserPopup(input: {
  opener: WebContents
  options: Electron.BrowserWindowConstructorOptions
  background?: boolean
  canPresent?: () => boolean
  onCreated: (options: PopupChildWindowOptions) => WebContents
}): Electron.WindowOpenHandlerResponse {
  const openerSession = input.opener.session
  const mayPresent = !isBackgroundLaunch() && input.options.show !== false
  const admit = (window: BrowserWindow): void => {
    markNativeBrowserPopupWindow(window)
    try {
      if (input.opener.isDestroyed() || window.webContents.session !== openerSession) {
        rejectNativeBrowserPopup(window)
        return
      }
      input.onCreated({ ...input.options, nativeWindow: window })
      if (input.background && mayPresent && !rejectedNativePopups.has(window)) {
        window.once('ready-to-show', () => {
          try {
            if (
              input.options.show === false ||
              isBackgroundLaunch() ||
              rejectedNativePopups.has(window) ||
              window.isDestroyed() ||
              window.webContents.isDestroyed() ||
              input.opener.isDestroyed() ||
              window.webContents.session !== openerSession ||
              (input.canPresent && !input.canPresent())
            ) {
              return
            }
            window.showInactive()
          } catch {}
        })
      }
    } catch {
      rejectNativeBrowserPopup(window)
    }
  }
  let admitted = false
  const onCreated = (_event: Electron.Event, window: BrowserWindow): void => {
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.session !== openerSession
    ) {
      return
    }
    app.off('browser-window-created', onCreated)
    admitted = true
    admit(window)
  }
  // Prepend prevents another browser-window-created listener from navigating the child first.
  app.prependListener('browser-window-created', onCreated)
  // A canceled native creation must not grant the next unrelated window this admission.
  queueMicrotask(() => {
    app.off('browser-window-created', onCreated)
    if (!admitted) {
      awaitScriptedNativePopup(input.opener, admit)
    }
  })
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      ...input.options,
      title: 'about:blank',
      fullscreenable: false,
      show: mayPresent && !input.background,
      // Content-sized like origin-bar popups, so resizeTo cannot hide the origin title.
      useContentSize: true,
      minWidth: MIN_POPUP_CONTENT_WIDTH,
      minHeight: MIN_POPUP_CONTENT_HEIGHT,
      webPreferences: { ...input.options.webPreferences, session: openerSession }
    }
  }
}

// did-create-window runs before the child's first request, allowing unadmitted children to be rejected.
function awaitScriptedNativePopup(
  opener: WebContents,
  admit: (window: BrowserWindow) => void
): void {
  if (opener.isDestroyed()) {
    return
  }
  if (!pendingScriptedNativePopups.has(opener)) {
    opener.prependListener('did-create-window', (window) => {
      if (isNativeBrowserPopupWindow(window)) {
        return
      }
      const pending = pendingScriptedNativePopups.get(opener)
      pendingScriptedNativePopups.set(opener, null)
      if (pending) {
        pending(window)
      } else {
        markNativeBrowserPopupWindow(window)
        rejectNativeBrowserPopup(window)
      }
    })
  }
  pendingScriptedNativePopups.set(opener, admit)
}

export function discardBrowserPopupContents(contents: WebContents): void {
  if (contents.isDestroyed()) {
    return
  }
  const denyNavigation = (event: Electron.Event): void => event.preventDefault()
  contents.on('will-navigate', denyNavigation)
  contents.on('will-frame-navigate', denyNavigation)
  contents.on('will-redirect', denyNavigation)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // close() is asynchronous during construction; the guards stop the pending request.
  try {
    contents.close()
  } catch {}
}

function rejectNativeBrowserPopup(window: BrowserWindow): void {
  rejectedNativePopups.add(window)
  discardBrowserPopupContents(window.webContents)
  // Wait for Electron's constructor to return before destroying the window.
  queueMicrotask(() => {
    if (!window.isDestroyed()) {
      window.destroy()
    }
  })
}

/** The native frame is the trust surface; public APIs cannot reparent its primary contents. */
export function prepareNativeBrowserPopup(
  window: BrowserWindow,
  prepareContent?: (contents: WebContents) => boolean
): PopupOriginBarWindow {
  const contents = window.webContents
  const closedListeners: (() => void)[] = []
  let closed = false
  window.once('closed', () => {
    closed = true
    for (const listener of closedListeners.splice(0)) {
      listener()
    }
  })
  const close = (): void => {
    if (!contents.isDestroyed()) {
      contents.close()
    }
  }
  const popup = {
    contentWebContents: contents,
    close,
    onClosed: (listener: () => void): void => {
      if (closed) {
        listener()
      } else {
        closedListeners.push(listener)
      }
    }
  }
  let prepared = false
  try {
    prepared = prepareContent?.(contents) ?? true
  } catch {}
  if (!prepared) {
    rejectNativeBrowserPopup(window)
    return popup
  }
  const quitNotice = attachNativePopupQuitNotice(window, contents)
  const updateOrigin = (): void => {
    if (!window.isDestroyed()) {
      window.setTitle(describeCommittedPopupOrigin(contents).label)
    }
    quitNotice.refreshOrigin()
  }
  window.on('page-title-updated', (event) => event.preventDefault())
  // A blocked/uncommitted redirect must never lend its origin to the old document.
  contents.on('did-navigate', updateOrigin)
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      updateOrigin()
    }
  })
  contents.on('did-fail-load', (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
    if (isMainFrame) {
      updateOrigin()
    }
  })
  updateOrigin()
  return popup
}
