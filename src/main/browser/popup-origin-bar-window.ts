import { BaseWindow, WebContentsView } from 'electron'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import {
  discardBrowserPopupContents,
  prepareNativeBrowserPopup
} from './browser-popup-native-window'
import { MIN_POPUP_CONTENT_HEIGHT, MIN_POPUP_CONTENT_WIDTH } from './popup-window-minimum-size'
import { describeCommittedPopupOrigin } from './popup-committed-origin'
import {
  attachPopupBarQuitNotice,
  POPUP_ORIGIN_BAR_HTML,
  POPUP_ORIGIN_BAR_HEIGHT
} from './popup-hold-quit-notice'
export { describePopupOrigin } from './popup-origin-description'
export { POPUP_ORIGIN_BAR_HEIGHT } from './popup-hold-quit-notice'

// Electron supplies an untyped webContents option; adopting it preserves OAuth opener/session state.
export type PopupChildWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: Electron.WebContents
  nativeWindow?: Electron.BrowserWindow
  // Cmd/Ctrl+Shift-click supplies no page; only GET requests can be reloaded by URL.
  loadInitialUrl?: boolean
}

export type PopupOriginBarWindow = {
  contentWebContents: Electron.WebContents
  close: () => void
  onClosed: (listener: () => void) => void
}

const DEFAULT_POPUP_CONTENT_WIDTH = 800
const DEFAULT_POPUP_CONTENT_HEIGHT = 600

function clampPopupContentSize(options: PopupChildWindowOptions): {
  width: number
  height: number
} {
  return {
    width: Math.max(MIN_POPUP_CONTENT_WIDTH, options.width ?? DEFAULT_POPUP_CONTENT_WIDTH),
    height: Math.max(MIN_POPUP_CONTENT_HEIGHT, options.height ?? DEFAULT_POPUP_CONTENT_HEIGHT)
  }
}

// Notify late onClosed listeners too, so callers can release bookkeeping after this immediate close.
function closeUnpreparedPopup(
  window: BaseWindow,
  contentWebContents: Electron.WebContents,
  originBarWebContents: Electron.WebContents
): PopupOriginBarWindow {
  const closedListeners: (() => void)[] = []
  let closed = false
  window.once('closed', () => {
    closed = true
    for (const listener of closedListeners.splice(0)) {
      listener()
    }
  })
  // A plain close lets an adopted link's pending first request reach the server.
  discardBrowserPopupContents(contentWebContents)
  if (!originBarWebContents.isDestroyed()) {
    originBarWebContents.close()
  }
  if (!window.isDestroyed()) {
    window.close()
  }
  return {
    contentWebContents,
    close: (): void => {
      if (!window.isDestroyed()) {
        window.close()
      }
    },
    onClosed: (listener: () => void): void => {
      if (closed) {
        listener()
        return
      }
      closedListeners.push(listener)
    }
  }
}

// Native child windows lack an address bar; untrusted popups need an Orca-controlled origin display.
export function openPopupWithOriginBar(
  options: PopupChildWindowOptions,
  initialUrl: string,
  // Apply guest policies before the popup's first load.
  prepareContent?: (contents: Electron.WebContents) => boolean
): PopupOriginBarWindow {
  if (options.nativeWindow) {
    return prepareNativeBrowserPopup(options.nativeWindow, prepareContent)
  }
  const { width, height } = clampPopupContentSize(options)
  const window = new BaseWindow({
    width,
    height: height + POPUP_ORIGIN_BAR_HEIGHT,
    // window.open requests content dimensions, excluding the native frame.
    useContentSize: true,
    ...(typeof options.x === 'number' && typeof options.y === 'number'
      ? { x: options.x, y: options.y }
      : {}),
    minWidth: MIN_POPUP_CONTENT_WIDTH,
    minHeight: MIN_POPUP_CONTENT_HEIGHT + POPUP_ORIGIN_BAR_HEIGHT,
    title: 'about:blank',
    // Windows/Linux attach the app menu to web popups too.
    autoHideMenuBar: true,
    show:
      Boolean(options.webContents || options.loadInitialUrl) &&
      !isBackgroundLaunch() &&
      options.show !== false
  })

  // Isolate the trusted origin bar from the arbitrary web content below it.
  const originBarView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const originBarWebContents = originBarView.webContents
  const contentView = new WebContentsView({
    // Electron rejects explicit undefined; omit it to let WebContentsView create contents.
    ...(options.webContents === undefined ? {} : { webContents: options.webContents }),
    webPreferences: options.webPreferences
  })
  window.contentView.addChildView(contentView)
  window.contentView.addChildView(originBarView)

  let originBarHeight = POPUP_ORIGIN_BAR_HEIGHT
  const layoutViews = (): void => {
    const bounds = window.getContentBounds()
    originBarView.setBounds({ x: 0, y: 0, width: bounds.width, height: originBarHeight })
    contentView.setBounds({
      x: 0,
      y: POPUP_ORIGIN_BAR_HEIGHT,
      width: bounds.width,
      height: Math.max(0, bounds.height - POPUP_ORIGIN_BAR_HEIGHT)
    })
  }
  window.on('resize', layoutViews)
  // Revealing the menu bar shrinks the content area without resizing the window.
  window.contentView.on('bounds-changed', layoutViews)
  // Re-pin on explicit fullscreen events; resize alone does not cover every platform.
  window.on('enter-full-screen', layoutViews)
  window.on('leave-full-screen', layoutViews)
  layoutViews()

  const contentWebContents = contentView.webContents
  if (
    (!options.webContents && !options.loadInitialUrl) ||
    (prepareContent && !prepareContent(contentWebContents))
  ) {
    return closeUnpreparedPopup(window, contentWebContents, originBarWebContents)
  }
  attachPopupBarQuitNotice({
    window,
    contents: contentWebContents,
    bar: originBarWebContents,
    layout: (height) => {
      originBarHeight = height
      layoutViews()
    }
  })
  const renderOrigin = (): void => {
    const { label, insecure } = describeCommittedPopupOrigin(contentWebContents)
    // Reset stale titles on navigation; only the origin bar is trusted to identify the destination.
    if (!window.isDestroyed()) {
      window.setTitle(label)
    }
    // Use textContent and JSON encoding because the origin label comes from untrusted URLs.
    void originBarWebContents
      .executeJavaScript(
        `document.body.classList.toggle('insecure', ${insecure ? 'true' : 'false'});` +
          `document.getElementById('origin').textContent = ${JSON.stringify(label)};`
      )
      .catch(() => {})
  }
  originBarWebContents.once('did-finish-load', renderOrigin)
  void originBarWebContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(POPUP_ORIGIN_BAR_HTML)}`
  )

  contentWebContents.on('did-navigate', renderOrigin)
  const handleInPageNavigate = (
    _event: Electron.Event,
    _url: string,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame) {
      renderOrigin()
    }
  }
  contentWebContents.on('did-navigate-in-page', handleInPageNavigate)
  const handleLoadFailure = (
    _event: Electron.Event,
    _errorCode: number,
    _errorDescription: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame) {
      return
    }
    // Error documents omit did-navigate; read the committed frame, never the failed target.
    renderOrigin()
  }
  contentWebContents.on('did-fail-load', handleLoadFailure)
  // Re-assert the committed origin after loads that may have dropped earlier writes.
  contentWebContents.on('did-finish-load', renderOrigin)
  const handlePageTitleUpdated = (event: Electron.Event, title: string): void => {
    event.preventDefault()
    if (
      !window.isDestroyed() &&
      title &&
      describeCommittedPopupOrigin(contentWebContents).label !== 'about:blank'
    ) {
      window.setTitle(title)
    }
  }
  contentWebContents.on('page-title-updated', handlePageTitleUpdated)
  renderOrigin()

  if (options.loadInitialUrl && !options.webContents) {
    void contentWebContents.loadURL(initialUrl).catch(() => {})
  }

  const closedListeners: (() => void)[] = []
  const handleContentDestroyed = (): void => {
    if (!window.isDestroyed()) {
      window.close()
    }
  }
  contentWebContents.once('destroyed', handleContentDestroyed)
  window.once('closed', () => {
    if (!contentWebContents.isDestroyed()) {
      contentWebContents.off('destroyed', handleContentDestroyed)
      contentWebContents.off('did-navigate', renderOrigin)
      contentWebContents.off('did-navigate-in-page', handleInPageNavigate)
      contentWebContents.off('did-fail-load', handleLoadFailure)
      contentWebContents.off('did-finish-load', renderOrigin)
      contentWebContents.off('page-title-updated', handlePageTitleUpdated)
      // Use close so OAuth unload handlers can notify the opener.
      contentWebContents.close()
    }
    // BaseWindow does not destroy child WebContentsView contents on close.
    if (!originBarWebContents.isDestroyed()) {
      originBarWebContents.close()
    }
    for (const listener of closedListeners) {
      listener()
    }
  })

  return {
    contentWebContents,
    close: (): void => {
      if (!window.isDestroyed()) {
        window.close()
      }
    },
    onClosed: (listener: () => void): void => {
      closedListeners.push(listener)
    }
  }
}
