import { BaseWindow, WebContentsView } from 'electron'

// Why: Electron passes the pre-created popup WebContents through the
// createWindow options (present at runtime, absent from the published d.ts).
// Adopting it — instead of constructing fresh contents — is what preserves
// window.opener and the inherited session that OAuth/SSO popups depend on.
export type PopupChildWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: Electron.WebContents
}

export type PopupOriginBarWindow = {
  contentWebContents: Electron.WebContents
  close: () => void
  onClosed: (listener: () => void) => void
}

export const POPUP_ORIGIN_BAR_HEIGHT = 34

const DEFAULT_POPUP_CONTENT_WIDTH = 800
const DEFAULT_POPUP_CONTENT_HEIGHT = 600
const MIN_POPUP_CONTENT_WIDTH = 360
const MIN_POPUP_CONTENT_HEIGHT = 200

// Why: http on loopback is a secure context (local OAuth callback servers are
// common); only flag plain http to a real remote host.
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

// Why: the bar must show only the origin — popup URLs routinely carry OAuth
// codes and one-time tokens in path/query that must never reach UI surfaces.
export function describePopupOrigin(rawUrl: string): { label: string; insecure: boolean } {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.origin !== 'null') {
      return {
        label: parsed.origin,
        insecure: parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)
      }
    }
    if (parsed.protocol === 'about:') {
      return { label: 'about:blank', insecure: false }
    }
    return { label: parsed.protocol, insecure: false }
  } catch {
    return { label: 'unknown', insecure: true }
  }
}

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

/**
 * Hosts a guest-opened popup inside an Orca-built window whose top strip is a
 * separate, Orca-controlled WebContentsView showing the popup's current
 * origin. A default Electron child window has no address bar, so arbitrary
 * web content could open windows whose destination the user cannot verify.
 */
export function openPopupWithOriginBar(
  options: PopupChildWindowOptions,
  initialUrl: string
): PopupOriginBarWindow {
  const { width, height } = clampPopupContentSize(options)
  const initialOrigin = describePopupOrigin(initialUrl)
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
    title: initialOrigin.label
  })

  // Why: the origin bar renders only Orca's own data: URL and must stay
  // isolated from the (arbitrary) popup content below it.
  const originBarView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
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
  // Why: HTML5 fullscreen makes the whole window fullscreen. resize covers
  // this on macOS, but re-pin on the explicit events too so the origin bar
  // provably stays above fullscreen content on every platform.
  window.on('enter-full-screen', layoutViews)
  window.on('leave-full-screen', layoutViews)
  layoutViews()

  const contentWebContents = contentView.webContents
  let currentUrl = initialUrl
  const renderOrigin = (): void => {
    const { label, insecure } = describePopupOrigin(currentUrl)
    // Why: origin is the title only until the page supplies one — the bar
    // below stays the trust surface, so the native title bar can show the
    // page title (Chrome popup behavior) instead of doubling the origin.
    // Re-asserting on navigation stops a stale title outliving its origin.
    if (!window.isDestroyed()) {
      window.setTitle(label)
    }
    // Why: textContent + JSON encoding — the URL is attacker-controlled and
    // must never be interpolated into the bar's markup.
    void originBarView.webContents
      .executeJavaScript(
        `document.body.classList.toggle('insecure', ${insecure ? 'true' : 'false'});` +
          `document.getElementById('origin').textContent = ${JSON.stringify(label)};`
      )
      .catch(() => {})
  }
  originBarView.webContents.once('did-finish-load', renderOrigin)
  void originBarView.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(ORIGIN_BAR_HTML)}`
  )

  const handleDidNavigate = (_event: Electron.Event, url: string): void => {
    currentUrl = url
    renderOrigin()
  }
  contentWebContents.on('did-navigate', handleDidNavigate)
  // Why: origin writes fail silently if the bar is mid-load; re-asserting at
  // load completion means a dropped write can never leave a stale origin up
  // for the lifetime of the page.
  contentWebContents.on('did-finish-load', renderOrigin)
  const handlePageTitleUpdated = (_event: Electron.Event, title: string): void => {
    if (!window.isDestroyed() && title) {
      window.setTitle(title)
    }
  }
  contentWebContents.on('page-title-updated', handlePageTitleUpdated)

  // Why: with no adopted contents there is no Chromium-driven navigation for
  // this popup, so load the target ourselves (opener handle is already gone).
  if (!options.webContents) {
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
      contentWebContents.off('did-navigate', handleDidNavigate)
      contentWebContents.off('did-finish-load', renderOrigin)
      contentWebContents.off('page-title-updated', handlePageTitleUpdated)
      // Why: close() (not destroy) so the page's unload handlers run — OAuth
      // pages often notify the opener from unload.
      contentWebContents.close()
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
