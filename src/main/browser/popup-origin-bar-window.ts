import { BaseWindow, WebContentsView } from 'electron'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import {
  discardBrowserPopupContents,
  prepareNativeBrowserPopup
} from './browser-popup-native-window'
import { MIN_POPUP_CONTENT_HEIGHT, MIN_POPUP_CONTENT_WIDTH } from './popup-window-minimum-size'
import { describeCommittedPopupOrigin } from './popup-committed-origin'
export { describePopupOrigin } from './popup-origin-description'

// Why: Electron passes the pre-created popup WebContents through the
// createWindow options (present at runtime, absent from the published d.ts).
// Adopting it — instead of constructing fresh contents — is what preserves
// window.opener and the inherited session that OAuth/SSO popups depend on.
export type PopupChildWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: Electron.WebContents
  nativeWindow?: Electron.BrowserWindow
  // Why: a Cmd/Ctrl+Shift-clicked link hands over no page; only a GET may be reloaded by URL.
  loadInitialUrl?: boolean
}

export type PopupOriginBarWindow = {
  contentWebContents: Electron.WebContents
  close: () => void
  onClosed: (listener: () => void) => void
}

export const POPUP_ORIGIN_BAR_HEIGHT = 34

const DEFAULT_POPUP_CONTENT_WIDTH = 800
const DEFAULT_POPUP_CONTENT_HEIGHT = 600

// Colors mirror the canonical tokens in src/renderer/src/assets/main.css
// (--background/--foreground/--border/--destructive); a data: URL page cannot
// import that stylesheet, so the values are inlined per theme here.
const ORIGIN_BAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; height: 100vh; box-sizing: border-box; padding: 0 10px;
    display: flex; align-items: center; gap: 8px;
    overflow: hidden; white-space: nowrap;
    -webkit-user-select: none; user-select: none; cursor: default;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #fff; color: #0a0a0a; border-bottom: 1px solid #e5e5e5;
  }
  #insecure { display: none; color: #e40014; font-weight: 600; }
  body.insecure #insecure { display: inline; }
  /* Elide the START of long origins so the registrable domain stays visible
     (Chrome elides the same side): rtl container puts clip+ellipsis on the
     left; the bdi keeps the ASCII origin itself rendering LTR. */
  #origin-clip { overflow: hidden; text-overflow: ellipsis; direction: rtl; }
  #origin { unicode-bidi: isolate; direction: ltr; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #fafafa; border-bottom-color: rgb(255 255 255 / 0.07); }
    #insecure { color: #ff6568; }
  }
</style></head><body><span id="insecure">Not secure</span><span id="origin-clip"><bdi id="origin"></bdi></span></body></html>`

function clampPopupContentSize(options: PopupChildWindowOptions): {
  width: number
  height: number
} {
  return {
    width: Math.max(MIN_POPUP_CONTENT_WIDTH, options.width ?? DEFAULT_POPUP_CONTENT_WIDTH),
    height: Math.max(MIN_POPUP_CONTENT_HEIGHT, options.height ?? DEFAULT_POPUP_CONTENT_HEIGHT)
  }
}

// Fail-closed teardown: the window never loads, and late onClosed listeners still fire so the
// caller's popup bookkeeping cannot leak an entry for a window that no longer exists.
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
  // Why: a plain close() lets an adopted link's pending first request reach the server.
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

/**
 * Hosts a guest-opened popup inside an Orca-built window whose top strip is a
 * separate, Orca-controlled WebContentsView showing the popup's current
 * origin. A default Electron child window has no address bar, so arbitrary
 * web content could open windows whose destination the user cannot verify.
 */
export function openPopupWithOriginBar(
  options: PopupChildWindowOptions,
  initialUrl: string,
  // Why: the only point that provably precedes the popup's first load — per-WebContents policy
  // that must hold before content runs (route-guest WebRTC) has to be applied here or not at all.
  prepareContent?: (contents: Electron.WebContents) => boolean
): PopupOriginBarWindow {
  if (options.nativeWindow) {
    return prepareNativeBrowserPopup(options.nativeWindow, prepareContent)
  }
  const { width, height } = clampPopupContentSize(options)
  const window = new BaseWindow({
    width,
    height: height + POPUP_ORIGIN_BAR_HEIGHT,
    // Why: window.open features request a content size; without this the
    // native frame eats into the popup's viewport.
    useContentSize: true,
    ...(typeof options.x === 'number' && typeof options.y === 'number'
      ? { x: options.x, y: options.y }
      : {}),
    minWidth: MIN_POPUP_CONTENT_WIDTH,
    minHeight: MIN_POPUP_CONTENT_HEIGHT + POPUP_ORIGIN_BAR_HEIGHT,
    title: 'about:blank',
    // Why: Windows/Linux attach Orca's app menu to every window, including web popups.
    autoHideMenuBar: true,
    show:
      Boolean(options.webContents || options.loadInitialUrl) &&
      !isBackgroundLaunch() &&
      options.show !== false
  })

  // Why: the origin bar renders only Orca's own data: URL and must stay
  // isolated from the (arbitrary) popup content below it.
  const originBarView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const originBarWebContents = originBarView.webContents
  const contentView = new WebContentsView({
    // Why: Electron rejects an explicitly undefined webContents; omitting it
    // lets WebContentsView create contents for Cmd/Ctrl-click popups.
    ...(options.webContents === undefined ? {} : { webContents: options.webContents }),
    webPreferences: options.webPreferences
  })
  window.contentView.addChildView(contentView)
  window.contentView.addChildView(originBarView)

  const layoutViews = (): void => {
    const bounds = window.getContentBounds()
    originBarView.setBounds({ x: 0, y: 0, width: bounds.width, height: POPUP_ORIGIN_BAR_HEIGHT })
    contentView.setBounds({
      x: 0,
      y: POPUP_ORIGIN_BAR_HEIGHT,
      width: bounds.width,
      height: Math.max(0, bounds.height - POPUP_ORIGIN_BAR_HEIGHT)
    })
  }
  window.on('resize', layoutViews)
  // Why: Alt-revealing the auto-hidden menu bar shrinks the content area without resizing the window.
  window.contentView.on('bounds-changed', layoutViews)
  // Why: HTML5 fullscreen makes the whole window fullscreen. resize covers
  // this on macOS, but re-pin on the explicit events too so the origin bar
  // provably stays above fullscreen content on every platform.
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
  const renderOrigin = (): void => {
    const { label, insecure } = describeCommittedPopupOrigin(contentWebContents)
    // Why: origin is the title only until the page supplies one — the bar
    // below stays the trust surface, so the native title bar can show the
    // page title (Chrome popup behavior) instead of doubling the origin.
    // Re-asserting on navigation stops a stale title outliving its origin.
    if (!window.isDestroyed()) {
      window.setTitle(label)
    }
    // Why: textContent + JSON encoding — the URL is attacker-controlled and
    // must never be interpolated into the bar's markup.
    void originBarWebContents
      .executeJavaScript(
        `document.body.classList.toggle('insecure', ${insecure ? 'true' : 'false'});` +
          `document.getElementById('origin').textContent = ${JSON.stringify(label)};`
      )
      .catch(() => {})
  }
  originBarWebContents.once('did-finish-load', renderOrigin)
  void originBarWebContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(ORIGIN_BAR_HTML)}`
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
  // Why: origin writes fail silently if the bar is mid-load; re-asserting at
  // load completion means a dropped write can never leave a stale origin up
  // for the lifetime of the page.
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
      // Why: close() (not destroy) so the page's unload handlers run — OAuth
      // pages often notify the opener from unload.
      contentWebContents.close()
    }
    // Why: BaseWindow does not destroy child WebContentsView contents when it closes.
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
