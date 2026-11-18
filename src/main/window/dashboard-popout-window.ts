import { translateMain } from '../i18n/main-i18n'
import { app, type BrowserWindow, type WebContents, type Event } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { rectHasVisibleAreaOnAnyDisplay } from './presentation/window-bounds-validation'
import { sendToTrustedUIRenderer } from '../ipc/ui'
import type { KeybindingOverrides } from '../../shared/keybindings/types'
import { createPopoutWindow, revealPopoutWindow } from './popout-window'

const MIN_WIDTH = 480
const MIN_HEIGHT = 360
const DEFAULT_WIDTH = 960
const DEFAULT_HEIGHT = 720
const DASHBOARD_POPOUT_PARTITION = 'orca-dashboard-popout'

// Reuse the companion window across Pop Out requests.
let dashboardPopoutWindow: BrowserWindow | null = null

/** Live popout for snapshot relaying, or null. */
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

// The main renderer publishes snapshots only while open; notify its exact trusted window before local listeners.
function broadcastPopoutOpenChanged(open: boolean): void {
  sendToTrustedUIRenderer('dashboard:popoutOpenChanged', open)
  for (const listener of popoutOpenListeners) {
    listener(open)
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

export function createOrFocusDashboardPopout(
  store: Store | null,
  options: { getKeybindings?: () => KeybindingOverrides | undefined } = {}
): BrowserWindow {
  if (dashboardPopoutWindow && !dashboardPopoutWindow.isDestroyed()) {
    revealPopoutWindow(dashboardPopoutWindow)
    return dashboardPopoutWindow
  }

  const savedBounds = resolveRestoredBounds(store)
  const window = createPopoutWindow(store, {
    getTitle: () => translateMain('native.dialog.dashboardTitle', 'Orca Agent Dashboard'),
    partition: DASHBOARD_POPOUT_PARTITION,
    bounds: {
      width: savedBounds?.width ?? DEFAULT_WIDTH,
      height: savedBounds?.height ?? DEFAULT_HEIGHT,
      ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {})
    },
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    getKeybindings: options.getKeybindings
  })
  dashboardPopoutWindow = window
  broadcastPopoutOpenChanged(true)

  // Freeze/debounce remembered bounds during teardown so resize events cannot replace them with minimum size.
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

  const freezeBounds = (event?: Event): void => {
    if (event?.defaultPrevented) {
      return
    }
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

  return window
}

/** Close with the owning main window so the dashboard cannot become orphaned. */
export function closeDashboardPopout(): void {
  if (dashboardPopoutWindow && !dashboardPopoutWindow.isDestroyed()) {
    dashboardPopoutWindow.close()
  }
  dashboardPopoutWindow = null
}
