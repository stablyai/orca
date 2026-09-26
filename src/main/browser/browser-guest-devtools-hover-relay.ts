import { BrowserWindow, screen } from 'electron'

type ScreenRect = { x: number; y: number; width: number; height: number }

const CURSOR_POLL_MS = 16
const GEOMETRY_REFRESH_MS = 250
const installedDevTools = new WeakSet<Electron.WebContents>()

function containsPoint(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

// Match by guest id: the live <webview> moves between the pane viewport and the retained host.
function buildHostWebviewRectScript(guestWebContentsId: number): string {
  return `(() => {
    for (const el of document.querySelectorAll('webview')) {
      let id = null
      try { id = el.getWebContentsId() } catch {}
      if (id !== ${guestWebContentsId}) continue
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    return null
  })()`
}

async function readHostGuestScreenRect(
  renderer: Electron.WebContents,
  guestWebContentsId: number
): Promise<ScreenRect | null> {
  const window = BrowserWindow.fromWebContents(renderer)
  if (!window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) {
    return null
  }
  const rect: ScreenRect | null = await renderer.executeJavaScript(
    buildHostWebviewRectScript(guestWebContentsId)
  )
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const content = window.getContentBounds()
  const zoom = renderer.getZoomFactor()
  return {
    x: content.x + rect.x * zoom,
    y: content.y + rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom
  }
}

async function readDevToolsWindowRect(devTools: Electron.WebContents): Promise<ScreenRect | null> {
  return devTools.executeJavaScript(
    '({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })'
  )
}

// Why: on macOS Chromium drops mouse moves for views in a window that is neither main nor key.
// Chrome lifts that while a debugger is attached; Electron does not, so while the detached DevTools
// window is key the guest never sees hover and inspect mode can't highlight. Relay the cursor instead.
export function installGuestDevToolsHoverRelay(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: (browserTabId: string) => Electron.WebContents | null
  // Emulated viewports scale the guest, so host geometry no longer maps to page coordinates.
  isViewportEmulated: () => boolean
}): void {
  if (process.platform !== 'darwin') {
    return
  }
  const { browserTabId, guest, resolveRenderer, isViewportEmulated } = args

  const install = (): void => {
    const devTools = guest.devToolsWebContents
    if (!devTools || devTools.isDestroyed() || installedDevTools.has(devTools)) {
      return
    }
    installedDevTools.add(devTools)

    let cursorTimer: ReturnType<typeof setInterval> | null = null
    let geometryTimer: ReturnType<typeof setInterval> | null = null
    let guestRect: ScreenRect | null = null
    let devToolsRect: ScreenRect | null = null
    let lastPoint: { x: number; y: number } | null = null

    const refreshGeometry = async (): Promise<void> => {
      const renderer = resolveRenderer(browserTabId)
      if (!renderer || guest.isDestroyed() || devTools.isDestroyed()) {
        guestRect = null
        return
      }
      try {
        const [nextGuestRect, nextDevToolsRect] = await Promise.all([
          readHostGuestScreenRect(renderer, guest.id),
          readDevToolsWindowRect(devTools)
        ])
        guestRect = nextGuestRect
        devToolsRect = nextDevToolsRect
      } catch {
        guestRect = null
      }
    }

    const relayCursor = (): void => {
      if (guest.isDestroyed() || !guestRect || isViewportEmulated()) {
        return
      }
      const cursor = screen.getCursorScreenPoint()
      // The DevTools window may overlap the page; the cursor over it belongs to DevTools.
      const inside =
        containsPoint(guestRect, cursor.x, cursor.y) &&
        !(devToolsRect && containsPoint(devToolsRect, cursor.x, cursor.y))
      if (!inside) {
        if (lastPoint) {
          lastPoint = null
          guest.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
        }
        return
      }
      const x = Math.round(cursor.x - guestRect.x)
      const y = Math.round(cursor.y - guestRect.y)
      if (lastPoint?.x === x && lastPoint.y === y) {
        return
      }
      lastPoint = { x, y }
      guest.sendInputEvent({ type: 'mouseMove', x, y })
    }

    const stop = (): void => {
      if (cursorTimer) {
        clearInterval(cursorTimer)
        cursorTimer = null
      }
      if (geometryTimer) {
        clearInterval(geometryTimer)
        geometryTimer = null
      }
      guestRect = null
      lastPoint = null
    }

    const start = (): void => {
      if (cursorTimer) {
        return
      }
      void refreshGeometry()
      geometryTimer = setInterval(() => void refreshGeometry(), GEOMETRY_REFRESH_MS)
      cursorTimer = setInterval(relayCursor, CURSOR_POLL_MS)
    }

    devTools.on('focus', start)
    devTools.on('blur', stop)
    devTools.once('destroyed', stop)
    guest.once('destroyed', stop)
    if (devTools.isFocused()) {
      start()
    }
  }

  if (guest.isDevToolsOpened()) {
    install()
    return
  }
  guest.once('devtools-opened', install)
}
