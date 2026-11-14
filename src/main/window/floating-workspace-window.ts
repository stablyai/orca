import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { join } from 'node:path'
import { mainI18n, translateMain } from '../i18n/main-i18n'
import type { Store } from '../persistence/loading-store/store'
import { getTrustedUIRendererWebContents } from '../ipc/ui'
import { FLOATING_WORKSPACE_WINDOW_SURFACE } from '../../shared/floating-workspace-window'
import { nativeZoomCommandMatchesKeybindings } from '../../shared/window-shortcut-policy'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../shared/keybindings'
import type { UIZoomDirection } from '../../shared/ui-zoom-level'
import { wslHostsWindowArguments } from '../wsl/host-lifecycle/wsl-host-gate'
import {
  isDashboardPopoutRenderer,
  resolveZoomShortcut,
  zoomDashboardPopout
} from './dashboard-popout-window'
import { isBackgroundLaunch, isWindowlessLaunch } from './activation/foreground-activation-policy'
import { installPrivilegedWindowNavigationPolicy } from './security/privileged-window-navigation'
import { rendererPublicationThrottle } from './visibility/renderer-publication-throttle'
import { isQuittingForUpdate } from '../updater/updater-service'
import {
  boundsOnCursorDisplay,
  isUsableOnCursorDisplay,
  placeOnCursorDisplay
} from './floating-workspace-window-placement'

const MIN_WIDTH = 480
const MIN_HEIGHT = 360
const DEFAULT_WIDTH = 960
const DEFAULT_HEIGHT = 640
const FLOATING_WORKSPACE_WINDOW_PARTITION = 'orca-floating-workspace-window'

export type FloatingWorkspaceWindowEvent = 'user-hidden' | 'destroyed'

let floatingWindow: BrowserWindow | null = null
// Why: ready-to-show must not override a hide requested before first paint.
let shownRequested = false
let focusRequested = false
// One-shot: the next show lands on the display under the cursor (set by the global chord).
let placeAtNextShow = false
let releaseThrottleLease: (() => void) | null = null
let getIsQuitting: () => boolean = () => false
const windowListeners = new Set<(event: FloatingWorkspaceWindowEvent) => void>()

/** Inject the quit probe; the window never sets or caches the flag itself. */
export function configureFloatingWorkspaceWindowLifecycle(options: {
  getIsQuitting: () => boolean
}): void {
  getIsQuitting = options.getIsQuitting
}

export function onFloatingWorkspaceWindowEvent(
  listener: (event: FloatingWorkspaceWindowEvent) => void
): () => void {
  windowListeners.add(listener)
  return () => windowListeners.delete(listener)
}

function notify(event: FloatingWorkspaceWindowEvent): void {
  for (const listener of windowListeners) {
    listener(event)
  }
}

export function getFloatingWorkspaceWindow(): BrowserWindow | null {
  return floatingWindow &&
    !floatingWindow.isDestroyed() &&
    !floatingWindow.webContents.isDestroyed()
    ? floatingWindow
    : null
}

export function requestFloatingWorkspaceWindowPlacement(): void {
  placeAtNextShow = true
}

/** A chord press while the window is open: bring it to the user's display. False means the press should toggle it closed. */
export function summonFloatingWorkspaceWindow(): boolean {
  const window = getFloatingWorkspaceWindow()
  if (!window || !shownRequested) {
    return false
  }
  if (window.isMinimized()) {
    window.restore()
  } else if (window.isVisible() && isUsableOnCursorDisplay(window)) {
    return false
  }
  placeOnCursorDisplay(window)
  presentWindow(window, true)
  return true
}

export function isFloatingWorkspaceWindowRenderer(sender: WebContents): boolean {
  return getFloatingWorkspaceWindow()?.webContents === sender
}

/** Companion windows granted text clipboard and native selection actions, never images or files. */
export function isDashboardOrFloatingRenderer(sender: WebContents): boolean {
  return isDashboardPopoutRenderer(sender) || isFloatingWorkspaceWindowRenderer(sender)
}

/** Zoom the focused window; false lets menu actions fall back to the next target. */
export function zoomFloatingWorkspaceWindowIfFocused(direction: UIZoomDirection): boolean {
  const window = getFloatingWorkspaceWindow()
  if (!window || !window.isFocused()) {
    return false
  }
  zoomDashboardPopout(window, direction)
  return true
}

function acquireThrottleLease(): void {
  if (releaseThrottleLease) {
    return
  }
  const renderer = getTrustedUIRendererWebContents()
  if (renderer) {
    releaseThrottleLease = rendererPublicationThrottle.acquire(renderer)
  }
}

function releaseThrottle(): void {
  releaseThrottleLease?.()
  releaseThrottleLease = null
}

function presentWindow(window: BrowserWindow, focus: boolean): void {
  if (focus && !isBackgroundLaunch()) {
    if (window.isVisible()) {
      window.focus()
    } else {
      window.show()
    }
    return
  }
  // Why showInactive: a foreground show() would activate the window on a no-focus restore.
  if (!window.isVisible() && !isWindowlessLaunch()) {
    window.showInactive()
  }
}

function loadFloatingWorkspaceWindow(window: BrowserWindow): void {
  const query = { surface: FLOATING_WORKSPACE_WINDOW_SURFACE }
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(
      `${process.env.ELECTRON_RENDERER_URL}/popout.html?${new URLSearchParams(query)}`
    )
  } else {
    void window.loadFile(join(__dirname, '../renderer/popout.html'), { query })
  }
}

function windowTitle(): string {
  return translateMain('native.dialog.floatingWorkspaceTitle', 'Orca Floating Workspace')
}

/** Hide, keeping the renderer and its grid claims; the main renderer learns only of user hides. */
export function hideFloatingWorkspaceWindow(): void {
  shownRequested = false
  placeAtNextShow = false
  releaseThrottle()
  getFloatingWorkspaceWindow()?.hide()
}

function hideByUser(): void {
  hideFloatingWorkspaceWindow()
  notify('user-hidden')
}

/** Last step of dock, flag-off and main-window close; destroy() skips the close event that would hide. */
export function destroyFloatingWorkspaceWindow(): void {
  shownRequested = false
  placeAtNextShow = false
  releaseThrottle()
  const window = floatingWindow
  floatingWindow = null
  if (window && !window.isDestroyed()) {
    window.destroy()
  }
  notify('destroyed')
}

/** Why destroy, not close: a close is prevented while quitting and would hang the quit. */
export function destroyFloatingWorkspaceWindowWithMainWindow(mainWindow: BrowserWindow): void {
  mainWindow.on('closed', destroyFloatingWorkspaceWindow)
}

function floatOverEverything(window: BrowserWindow): void {
  window.setAlwaysOnTop(true, 'floating')
  if (process.platform !== 'win32') {
    // skipTransformProcessType keeps Orca's Dock icon from flickering out.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
  }
}

/** Create or reveal the single window; a repeated show takes no second throttle lease. */
export function showFloatingWorkspaceWindow(
  store: Store | null,
  options: { focus: boolean; getKeybindings?: () => KeybindingOverrides | undefined }
): BrowserWindow {
  shownRequested = true
  focusRequested = options.focus
  const place = placeAtNextShow
  placeAtNextShow = false
  acquireThrottleLease()
  const existing = getFloatingWorkspaceWindow()
  if (existing) {
    if (existing.webContents.isCrashed()) {
      existing.webContents.reload()
    }
    if (existing.isMinimized()) {
      existing.restore()
    }
    if (place) {
      placeOnCursorDisplay(existing)
    }
    presentWindow(existing, options.focus)
    return existing
  }

  const wslArguments = wslHostsWindowArguments()
  const darwin = process.platform === 'darwin'
  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    ...(place ? boundsOnCursorDisplay(DEFAULT_WIDTH, DEFAULT_HEIGHT) : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: windowTitle(),
    show: false,
    // Why: a panel takes key focus without activating Orca, so focusing it never raises the main window; a full-screen-able one would open its own Space.
    ...(darwin ? { type: 'panel' as const, fullscreenable: false } : {}),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // Chromium shares zoom by origin; isolate the session to keep window zoom local.
      partition: FLOATING_WORKSPACE_WINDOW_PARTITION,
      webviewTag: false,
      ...(wslArguments.length > 0 ? { additionalArguments: wslArguments } : {})
    }
  })
  floatOverEverything(window)
  installPrivilegedWindowNavigationPolicy(window.webContents)
  // Isolated sessions do not inherit the main session's deny-by-default permission policy.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  floatingWindow = window

  window.webContents.on('dom-ready', () => {
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
    }
  })
  // Compare against the last app zoom so local changes persist until app-wide zoom changes.
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

  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }
    const keybindings = options.getKeybindings?.()
    if (
      keybindingMatchesAction('floatingTerminal.toggle', input, process.platform, keybindings, {
        context: 'app'
      })
    ) {
      event.preventDefault()
      hideByUser()
      return
    }
    const direction = resolveZoomShortcut(input, keybindings)
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
    if (shownRequested && floatingWindow === window) {
      presentWindow(window, focusRequested)
    }
  })

  // Why: a prevented close during quit lets the main window's `closed` destroy this window; hiding then would read as a user hide. macOS quitAndInstall closes windows before before-quit sets the flag.
  window.on('close', (event) => {
    event.preventDefault()
    if (!(getIsQuitting() || isQuittingForUpdate())) {
      hideByUser()
    }
  })

  window.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  const updateTitle = (): void => {
    if (!window.isDestroyed()) {
      window.setTitle(windowTitle())
    }
  }
  mainI18n.on('languageChanged', updateTitle)

  window.on('closed', () => {
    mainI18n.off('languageChanged', updateTitle)
    unsubscribeUIChanged?.()
    if (floatingWindow === window) {
      destroyFloatingWorkspaceWindow()
    }
  })

  loadFloatingWorkspaceWindow(window)
  return window
}
