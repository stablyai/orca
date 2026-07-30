import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { Store } from '../persistence'
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

const MIN_WIDTH = 480
const MIN_HEIGHT = 360
const DEFAULT_WIDTH = 960
const DEFAULT_HEIGHT = 720
const DEFAULT_VIEW = 'kanban'
const DASHBOARD_POPOUT_PARTITION = 'orca-dashboard-popout'

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
  // Why: this runs on every keydown; avoid scanning unrelated window shortcuts in the typing path.
  for (const [actionId, direction] of ZOOM_SHORTCUTS) {
    if (
      keybindingMatchesAction(actionId, input, process.platform, keybindings, { context: 'app' })
    ) {
      return direction
    }
  }
  return null
}

/**
 * Apply a zoom step to the pop-out when it is the focused window. Returns false
 * when the pop-out is closed or unfocused so the caller can route the action to
 * the main window instead — the menu's zoom items must act on the window the
 * user is looking at.
 */
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
  view: string = DEFAULT_VIEW,
  options: { getKeybindings?: () => KeybindingOverrides | undefined } = {}
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
      // Why: Chromium shares zoom by origin; a separate in-memory session keeps pop-out zoom window-local.
      partition: DASHBOARD_POPOUT_PARTITION,
      // Why: the dashboard is plain DOM — no <webview> guests — so keep the
      // guest-embedding surface off for this window.
      webviewTag: false
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  // Why: isolated sessions do not inherit the main session's deny-by-default permission policy.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  dashboardPopoutWindow = window
  broadcastPopoutOpenChanged(true)

  // Why: uiZoomLevel is the app-wide UI zoom; without this the pop-out always
  // renders at 100% while the main window honors the persisted level.
  window.webContents.on('dom-ready', () => {
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
    }
  })
  // Follow app-zoom changes made while the pop-out is open (main-window zoom,
  // settings control, mobile ui.set). Compare against the last followed value,
  // not the live webContents level, so a window-local zoom via the menu/chords
  // is not snapped back until the app-wide level actually changes.
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

  // Why: the pop-out has no renderer-side shortcut plumbing; resolve only the
  // zoom chords here and let every other key fall through untouched.
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
    // Why: Electron reports Ctrl/Cmd+wheel zoom outside the keyboard input path.
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
    unsubscribeUIChanged?.()
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
