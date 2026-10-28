import { app, BrowserWindow, nativeTheme, type WebContents, type Event } from 'electron'
import { join } from 'node:path'
import type { Store } from '../persistence'
import { isBackgroundLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { sendToTrustedUIRenderer } from '../ipc/ui'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { stepUIZoomLevel, type UIZoomDirection } from '../../shared/ui-zoom-level'
import { nativeZoomCommandMatchesKeybindings } from '../../shared/window-shortcut-policy'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../shared/keybindings'
import { wslHostsWindowArguments } from '../wsl/wsl-host-gate'

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

function zoomDashboardPopout(window: BrowserWindow, direction: UIZoomDirection): void {
  const webContents = window.webContents
  webContents.setZoomLevel(stepUIZoomLevel(webContents.getZoomLevel(), direction))
}

const ZOOM_SHORTCUTS: readonly [KeybindingActionId, UIZoomDirection][] = [
  ['zoom.in', 'in'],
  ['zoom.out', 'out'],
  ['zoom.reset', 'reset']
]

function resolveZoomShortcut(
  input: KeybindingInput,
  keybindings: KeybindingOverrides | undefined
): UIZoomDirection | null {
  // This runs per keydown; inspect only zoom shortcuts.
  for (const [actionId, direction] of ZOOM_SHORTCUTS) {
    if (
      keybindingMatchesAction(actionId, input, process.platform, keybindings, { context: 'app' })
    ) {
      return direction
    }
  }
  return null
}

/** Zoom the focused popout; return false so menu actions can fall back to the main window. */
export function zoomDashboardPopoutIfFocused(direction: UIZoomDirection): boolean {
  const popout = getDashboardPopoutWindow()
  if (!popout || !popout.isFocused()) {
    return false
  }
  zoomDashboardPopout(popout, direction)
  return true
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

function loadDashboardPopout(window: BrowserWindow): void {
  // Match main-window loading: dev server entry versus packaged emitted HTML.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/popout.html'))
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

/** Reuse a native-framed companion window with the main preload and its own popout.html renderer. */
export function createOrFocusDashboardPopout(
  store: Store | null,
  options: { getKeybindings?: () => KeybindingOverrides | undefined } = {}
): BrowserWindow {
  if (dashboardPopoutWindow && !dashboardPopoutWindow.isDestroyed()) {
    if (dashboardPopoutWindow.isMinimized()) {
      dashboardPopoutWindow.restore()
    }
    if (!isBackgroundLaunch()) {
      dashboardPopoutWindow.focus()
    }
    return dashboardPopoutWindow
  }

  const savedBounds = resolveRestoredBounds(store)

  // Serve-only: this window lists saved WSL hosts and their Connect, as the main window does.
  const wslArguments = wslHostsWindowArguments()
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
    // Use native movable/closable chrome on every platform; the popout renders no custom titlebar.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // Chromium shares zoom by origin; isolate the session to keep popout zoom local.
      partition: DASHBOARD_POPOUT_PARTITION,
      // No webviews run here; disable embedding and omit host identity so client-placed pages stay mirrors.
      webviewTag: false,
      ...(wslArguments.length > 0 ? { additionalArguments: wslArguments } : {})
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  // Isolated sessions do not inherit the main session's deny-by-default permission policy.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  dashboardPopoutWindow = window
  broadcastPopoutOpenChanged(true)

  // Apply persisted app zoom or the popout always opens at 100%.
  window.webContents.on('dom-ready', () => {
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
    }
  })
  // Compare against last app zoom, not live window zoom, so local changes persist until app-wide zoom actually changes.
  let lastFollowedZoomLevel = store?.getUI().uiZoomLevel ?? 0
  const unsubscribeUIChanged = store?.onUIChanged((ui) => {
    const level = ui.uiZoomLevel ?? 0
    if (level === lastFollowedZoomLevel) {
      return
    }
    lastFollowedZoomLevel = level
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(level)
    }
  })

  // No renderer shortcut routing exists here; handle zoom chords and yield everything else.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }
    const direction = resolveZoomShortcut(input, options.getKeybindings?.())
    if (direction) {
      event.preventDefault()
      zoomDashboardPopout(window, direction)
    }
  })

  window.webContents.on('zoom-changed', (event, direction) => {
    // Ctrl/Cmd+wheel arrives outside keyboard input routing.
    if (
      (direction === 'in' || direction === 'out') &&
      nativeZoomCommandMatchesKeybindings(direction, process.platform, options.getKeybindings?.(), {
        context: 'app'
      })
    ) {
      event.preventDefault()
      zoomDashboardPopout(window, direction)
    }
  })

  window.once('ready-to-show', () => {
    showWindowWithoutStealingFocus(window)
  })

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
    unsubscribeUIChanged?.()
    if (dashboardPopoutWindow === window) {
      dashboardPopoutWindow = null
    }
    broadcastPopoutOpenChanged(false)
  })

  loadDashboardPopout(window)
  return window
}

/** Close with the owning main window so the dashboard cannot become orphaned. */
export function closeDashboardPopout(): void {
  if (dashboardPopoutWindow && !dashboardPopoutWindow.isDestroyed()) {
    dashboardPopoutWindow.close()
  }
  dashboardPopoutWindow = null
}
