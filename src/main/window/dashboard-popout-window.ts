import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { Store } from '../persistence'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { sendToTrustedUIRenderer } from '../ipc/ui'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

const MIN_WIDTH = 480
const MIN_HEIGHT = 360
const DEFAULT_WIDTH = 960
const DEFAULT_HEIGHT = 720
const DEFAULT_VIEW = 'kanban'

// Why: singleton — the dashboard is a companion surface, so a second "Pop Out"
// request focuses the existing window rather than spawning duplicates.
let dashboardPopoutWindow: BrowserWindow | null = null

/** The live pop-out window, or null when closed. Used by the dashboard relay to
 *  forward snapshots to the popout's webContents. */
export function getDashboardPopoutWindow(): BrowserWindow | null {
  return dashboardPopoutWindow &&
    !dashboardPopoutWindow.isDestroyed() &&
    !dashboardPopoutWindow.webContents.isDestroyed()
    ? dashboardPopoutWindow
    : null
}

export function isDashboardPopoutRenderer(sender: WebContents): boolean {
  return getDashboardPopoutWindow()?.webContents === sender
}

// In-process listeners (the dashboard relay clears its cached snapshot on close).
const popoutOpenListeners = new Set<(open: boolean) => void>()

/** Subscribe to pop-out open/close transitions in the main process. */
export function onDashboardPopoutOpenChanged(listener: (open: boolean) => void): () => void {
  popoutOpenListeners.add(listener)
  return () => popoutOpenListeners.delete(listener)
}

// Why: the main renderer's snapshot publisher only runs while the pop-out is
// open. Tell that exact window when the state flips, then notify listeners.
function broadcastPopoutOpenChanged(open: boolean): void {
  sendToTrustedUIRenderer('dashboard:popoutOpenChanged', open)
  for (const listener of popoutOpenListeners) {
    listener(open)
  }
}

function loadDashboardPopout(window: BrowserWindow, view: string): void {
  const search = `view=${encodeURIComponent(view)}`
  // Why: mirror loadMainWindow's dev/prod branch — the dev server serves the
  // second HTML entry, prod loads the emitted file.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html?${search}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/popout.html'), { search })
  }
}

function resolveRestoredBounds(store: Store | null): {
  x: number
  y: number
  width: number
  height: number
} | null {
  const raw = store?.getUI().dashboardPopoutBounds ?? null
  if (
    raw &&
    raw.width >= MIN_WIDTH &&
    raw.height >= MIN_HEIGHT &&
    rectHasVisibleAreaOnAnyDisplay(raw, MIN_WIDTH / 2, MIN_HEIGHT / 2)
  ) {
    return raw
  }
  if (raw) {
    console.warn('[dashboard-popout] Discarding off-screen/near-min popout bounds:', raw)
  }
  return null
}

/**
 * Open the pop-out dashboard window, or focus it if already open. The window is
 * a standalone top-level BrowserWindow with a native frame that reuses the same
 * preload/window.api as the main window but renders its own React root
 * (popout.html?view=…).
 */
export function createOrFocusDashboardPopout(
  store: Store | null,
  view: string = DEFAULT_VIEW
): BrowserWindow {
  if (dashboardPopoutWindow && !dashboardPopoutWindow.isDestroyed()) {
    if (dashboardPopoutWindow.isMinimized()) {
      dashboardPopoutWindow.restore()
    }
    dashboardPopoutWindow.focus()
    return dashboardPopoutWindow
  }

  const savedBounds = resolveRestoredBounds(store)

  const window = new BrowserWindow({
    width: savedBounds?.width ?? DEFAULT_WIDTH,
    height: savedBounds?.height ?? DEFAULT_HEIGHT,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Orca Agent Dashboard',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    // Why: the pop-out uses a standard native frame so it is movable, closable,
    // and minimizable on every platform without reimplementing the main
    // window's custom titlebar/drag-region/window-control chrome. The main
    // window is frameless because it draws its own titlebar; the dashboard has
    // no such chrome yet, so a native frame is the correct default here.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // Why: the dashboard is plain DOM — no <webview> guests — so keep the
      // guest-embedding surface off for this window.
      webviewTag: false
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  dashboardPopoutWindow = window
  broadcastPopoutOpenChanged(true)

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })

  // Bounds persistence — mirrors the main window's debounced/frozen approach so
  // teardown-time resize/move events can't clobber the remembered size with
  // near-minimum bounds.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  let windowClosing = false
  const saveBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (windowClosing || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) {
        return
      }
      const bounds = window.getBounds()
      if (bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) {
        return
      }
      store?.updateUI({ dashboardPopoutBounds: bounds })
    }, 500)
  }
  window.on('resize', saveBounds)
  window.on('move', saveBounds)

  const freezeBounds = (): void => {
    windowClosing = true
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
  }
  window.on('close', freezeBounds)
  app.on('before-quit', freezeBounds)

  window.on('closed', () => {
    app.removeListener('before-quit', freezeBounds)
    if (dashboardPopoutWindow === window) {
      dashboardPopoutWindow = null
    }
    broadcastPopoutOpenChanged(false)
  })

  loadDashboardPopout(window, view)
  return window
}

/** Close the pop-out dashboard if it is open. Called when the main window
 *  closes so the dashboard never orphans without its owning app window. */
export function closeDashboardPopout(): void {
  if (dashboardPopoutWindow && !dashboardPopoutWindow.isDestroyed()) {
    dashboardPopoutWindow.close()
  }
  dashboardPopoutWindow = null
}
