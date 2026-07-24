/* oxlint-disable max-lines */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  screen
} from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { Store } from '../persistence'
import { getAppIconPath } from '../app-icon'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { translateMain } from '../i18n/main-i18n'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { isCrashReportReason } from '../../shared/crash-reporting'
import {
  DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES,
  DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
  RendererRecoveryCircuitBreaker
} from '../crash-reporting/renderer-recovery-circuit-breaker'
import {
  getWindowShortcutActionId,
  matchesRecentTabSwitcherChord,
  nativeZoomCommandMatchesKeybindings,
  resolveWindowShortcutAction,
  windowShortcutActionCapturesTerminal,
  type WindowShortcutAction
} from '../../shared/window-shortcut-policy'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'
import {
  normalizeTerminalShortcutPolicy,
  type KeybindingMatchOptions,
  type KeybindingOverrides
} from '../../shared/keybindings'
import { getMainE2EConfig } from '../e2e-config'
import { buildEditableContextMenuTemplate } from './editable-context-menu'
import { clearTrustedUIRendererWebContentsId, setTrustedUIRendererWebContentsId } from '../ipc/ui'
import { resolveWindowCloseAction } from './window-close-decision'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { closeDashboardPopout } from './dashboard-popout-window'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { isMacosTahoeOrNewer } from './macos-tahoe-release'

// Why: show/restore/resume can overlap before the size nudge resets; never capture the temporary width as the next baseline.
const activeRepaintJiggles = new WeakSet<BrowserWindow>()
export const WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS = 10_000

function forceRepaint(window: BrowserWindow): void {
  // Why: webContents can be destroyed a beat before the BrowserWindow during close, and this runs from timers/focus events in that gap.
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  window.webContents.invalidate()
  if (window.isMaximized() || window.isFullScreen() || activeRepaintJiggles.has(window)) {
    return
  }
  // Why: macOS 26 scene-backed windows can deadlock the main thread on re-entrant frame updates; invalidate alone recovers the compositor there.
  if (isMacosTahoeOrNewer()) {
    return
  }
  activeRepaintJiggles.add(window)
  // Why: show/restore fire from inside AppKit's window-state dispatch; mutating the frame there re-enters scene handling, so nudge on a fresh turn.
  setTimeout(() => {
    if (window.isDestroyed()) {
      activeRepaintJiggles.delete(window)
      return
    }
    const [width, height] = window.getSize()
    window.setSize(width + 1, height)
    setTimeout(() => {
      if (!window.isDestroyed()) {
        window.setSize(width, height)
      }
      activeRepaintJiggles.delete(window)
    }, 32)
  }, 0)
}

function installMacosVisibilityRepaint(window: BrowserWindow): void {
  let delayedRepaintTimer: ReturnType<typeof setTimeout> | null = null
  const repaintAfterVisibilityTransition = (): void => {
    forceRepaint(window)
    if (delayedRepaintTimer) {
      clearTimeout(delayedRepaintTimer)
    }
    // Why: macOS may restore compositor layers after the show/restore event; a second paint catches late black-surface recovery.
    delayedRepaintTimer = setTimeout(() => {
      delayedRepaintTimer = null
      forceRepaint(window)
    }, 250)
  }
  const clearDelayedRepaint = (): void => {
    if (delayedRepaintTimer) {
      clearTimeout(delayedRepaintTimer)
      delayedRepaintTimer = null
    }
  }

  window.on('restore', repaintAfterVisibilityTransition)
  window.on('show', repaintAfterVisibilityTransition)
  // Why: occlusion-uncover fires no restore/show, only focus; invalidate only — the setSize jiggle would SIGWINCH every terminal on Cmd+Tab.
  window.on('focus', () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.invalidate()
    }
  })
  window.on('closed', clearDelayedRepaint)
}

function isMacAppPasteInput(input: Electron.Input): boolean {
  return (
    process.platform === 'darwin' &&
    input.type === 'keyDown' &&
    input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    (input.code === 'KeyV' || input.key.toLowerCase() === 'v')
  )
}

// Why: titlebar content center sits ~18 CSS px from top (×zoom); traffic lights are ~12px tall, so top edge = center − 6.
const TITLEBAR_CSS_CENTER = 18
const TRAFFIC_LIGHT_RADIUS = 6
const TRAFFIC_LIGHT_X = 16
const MIN_WIDTH = 600
const MIN_HEIGHT = 400

function syncTrafficLightPosition(win: BrowserWindow, zoomFactor: number): void {
  if (process.platform !== 'darwin' || win.isDestroyed()) {
    return
  }
  const y = Math.round(TITLEBAR_CSS_CENTER * zoomFactor - TRAFFIC_LIGHT_RADIUS)
  win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y })
}

type CreateMainWindowOptions = {
  /** Returns true when a manual app.quit() (Cmd+Q) is in progress, so the renderer skips the running-process confirm dialog. */
  getIsQuitting?: () => boolean
  /** Notifies the caller when the renderer vetoes unload, so the quit latch clears — a prevented beforeunload cancels the in-flight app.quit(). */
  onQuitAborted?: () => void
  onRendererProcessGone?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => void
  /** Returns true when Orca should reload after renderer loss; update-relaunch/quit tear down children intentionally, so don't fight shutdown. */
  shouldRecoverRenderer?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => boolean
  /** Called when consecutive auto-recoveries hit the circuit-breaker limit so the host can prompt instead of crash-looping. */
  onRendererRecoveryExhausted?: (info: {
    details: Electron.RenderProcessGoneDetails
    webContentsId: number
    recentRecoveryCount: number
  }) => void
  /** Defer renderer load until IPC handlers are registered, or eager renderer calls race into missing channels. */
  deferLoad?: boolean
  title?: string
  getKeybindings?: () => KeybindingOverrides | undefined
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /** Marks the in-place recovery reload so did-finish-load's PTY orphan sweep spares live sessions until restore re-attaches (#5787). */
  onBeforeRecoveryReload?: (webContentsId: number) => void
}

export function loadMainWindow(mainWindow: BrowserWindow): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

export function createMainWindow(
  store: Store | null,
  opts?: CreateMainWindowOptions
): BrowserWindow {
  const rawSavedBounds = store?.getUI().windowBounds
  // Why: reject min-size or substantially off-screen bounds so the titlebar stays reachable after display changes.
  const savedBounds =
    rawSavedBounds &&
    rawSavedBounds.width > MIN_WIDTH &&
    rawSavedBounds.height > MIN_HEIGHT &&
    rectHasVisibleAreaOnAnyDisplay(rawSavedBounds, MIN_WIDTH / 2, MIN_HEIGHT / 2)
      ? rawSavedBounds
      : undefined
  if (rawSavedBounds && !savedBounds) {
    console.warn(
      '[window] Discarding persisted windowBounds and falling back to defaultBounds:',
      rawSavedBounds
    )
  }
  const savedMaximized = store?.getUI().windowMaximized ?? false
  // Why: on first launch fill the primary display work area so the window feels spacious without maximize(); saved bounds win later.
  const defaultBounds = (() => {
    try {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize
      return { width, height }
    } catch {
      return { width: 1200, height: 800 }
    }
  })()

  const settings = store?.getSettings()
  browserManager.setDictationShortcutForwardingPredicate(() => {
    // Why: webview guests expose no safe transcript insertion target; let Cmd/Ctrl+E reach the page instead of dropping dictation text.
    return false
  })
  const blur = settings?.windowBackgroundBlur ?? false
  // Why: blur uses platform APIs (macOS vibrancy+transparent, Windows backgroundMaterial, Linux none) and only applies at creation, needs restart.
  const platformBlurOptions = blur
    ? process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const, transparent: true }
      : process.platform === 'win32'
        ? { backgroundMaterial: 'acrylic' as const }
        : {}
    : {}

  const mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? defaultBounds.width,
    height: savedBounds?.height ?? defaultBounds.height,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: opts?.title ?? 'Orca',
    show: false,
    // Why: macOS swallows the app-activating click by default, so clicking back into Orca needed a second click (Windows/Linux already deliver it).
    acceptFirstMouse: true,
    // Why: auto-hide the Windows/Linux menu bar to save a row (Alt reveals it); macOS uses the system menu bar anyway.
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    // Why: macOS 'hiddenInset' keeps native traffic lights in our custom titlebar; Windows 'hidden' removes the OS title bar so it doesn't double up.
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : undefined,
    // Why: Linux ignores titleBarStyle 'hidden'; frame:false drops the native frame so we don't get a double title bar (renderer draws its own).
    ...(process.platform === 'linux' ? { frame: false } : {}),
    // Why: initial position for 1x zoom; syncTrafficLightPosition() adjusts on zoom change.
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: {
            x: TRAFFIC_LIGHT_X,
            y: TITLEBAR_CSS_CENTER - TRAFFIC_LIGHT_RADIUS
          }
        }
      : {}),
    icon: getAppIconPath(settings?.appIcon),
    ...platformBlurOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webviewTag: true
    }
  })
  const rendererWebContentsId = mainWindow.webContents.id
  // Why: native paste fallback is privileged IPC; only the top-level renderer may request it.
  setTrustedUIRendererWebContentsId(rendererWebContentsId)

  if (process.platform === 'darwin') {
    // Why: throttle the main window while hidden (guests self-unthrottle); toggle only while visible or Chromium blanks the surface (electron#42378).
    mainWindow.webContents.setBackgroundThrottling(true)
    installMacosVisibilityRepaint(mainWindow)
  }

  // Why: a focus-preserving wake fires no focus/visibility events; relay resume so terminal wake recovery runs and force a repaint so stale compositor surfaces recover.
  const onSystemResume = (): void => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed?.() === true) {
      return
    }
    forceRepaint(mainWindow)
    mainWindow.webContents.send('system:resumed')
  }
  powerMonitor.on('resume', onSystemResume)

  mainWindow.webContents.on('dom-ready', () => {
    const level = store?.getUI().uiZoomLevel ?? 0
    mainWindow.webContents.setZoomLevel(level)
    // Why: native traffic lights don't scale with CSS zoom; reposition on startup to stay aligned with the zoomed titlebar.
    if (process.platform === 'darwin') {
      syncTrafficLightPosition(mainWindow, Math.pow(1.2, level))
    }
  })

  // Why: macOS+Electron 41 re-emits ready-to-show on webview-guest creation; a one-shot guard stops re-running maximize() after resize (#591).
  let handledInitialReadyToShow = false
  let initialRevealFallbackTimer: ReturnType<typeof setTimeout> | null =
    process.platform === 'win32' || process.platform === 'linux'
      ? setTimeout(() => {
          // Why: GPU/driver failures on Windows/Linux can prevent ready-to-show forever, hiding the only app window (#8421).
          initialRevealFallbackTimer = null
          revealInitialWindow()
        }, 10_000)
      : null
  initialRevealFallbackTimer?.unref?.()

  const clearInitialRevealFallbackTimer = (): void => {
    if (initialRevealFallbackTimer) {
      clearTimeout(initialRevealFallbackTimer)
      initialRevealFallbackTimer = null
    }
  }

  const revealInitialWindow = (): void => {
    if (mainWindow.isDestroyed()) {
      clearInitialRevealFallbackTimer()
      return
    }
    if (handledInitialReadyToShow) {
      return
    }
    handledInitialReadyToShow = true
    clearInitialRevealFallbackTimer()

    // Why: in E2E headless mode keep the window hidden (Playwright drives via CDP) so tests don't steal focus.
    const e2eConfig = getMainE2EConfig()
    if (e2eConfig.headless) {
      return
    }
    if (savedMaximized) {
      mainWindow.maximize()
    }
    mainWindow.show()
  }
  mainWindow.on('ready-to-show', revealInitialWindow)

  // Why: persist window bounds to restore last position/size; debounce to avoid hammering persistence during resize drags.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  // Why: teardown still emits resize/move/unmaximize at near-min bounds; freeze persistence once closing so they can't clobber the saved size.
  let windowClosing = false
  const saveBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (windowClosing || mainWindow.isDestroyed() || mainWindow.isFullScreen()) {
        return
      }
      // Why: persist windowMaximized and windowBounds atomically; the near-min guard must not leave them a mismatched pair.
      const isMaximized = mainWindow.isMaximized()
      if (isMaximized) {
        store?.updateUI({ windowMaximized: true })
        return
      }
      const bounds = mainWindow.getBounds()
      // Why: never persist shrink-to-min bounds (teardown race past the freeze, PR #1269); fall back to defaultBounds next launch.
      if (bounds.width <= MIN_WIDTH || bounds.height <= MIN_HEIGHT) {
        console.warn('[window] Skipping persist of near-minimum windowBounds:', bounds)
        store?.updateUI({ windowMaximized: false })
        return
      }
      store?.updateUI({ windowMaximized: false, windowBounds: bounds })
    }, 500)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  // Why: the auto-updater calls removeAllListeners('close') before quitting, so latch on app 'before-quit' too to freeze bounds during teardown.
  const freezeBoundsOnQuit = (): void => {
    windowClosing = true
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
  }
  app.on('before-quit', freezeBoundsOnQuit)

  mainWindow.on('maximize', () => {
    if (windowClosing) {
      return
    }
    store?.updateUI({ windowMaximized: true })
    mainWindow.webContents.send('window:maximize-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    if (windowClosing) {
      return
    }
    mainWindow.webContents.send('window:maximize-changed', false)
    const bounds = mainWindow.getBounds()
    // Why: mirror the saveBounds guard — unmaximize during teardown can land at min size; don't persist that as remembered size.
    if (bounds.width <= MIN_WIDTH || bounds.height <= MIN_HEIGHT) {
      console.warn('[window] Skipping unmaximize-time persist of near-min bounds:', bounds)
      store?.updateUI({ windowMaximized: false })
      return
    }
    store?.updateUI({ windowMaximized: false, windowBounds: bounds })
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen-changed', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen-changed', false)
  })

  installPrivilegedWindowNavigationPolicy(mainWindow.webContents)

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''

    // Why: fail closed — deny any src or partition not in the registry allowlist so a renderer bug can't smuggle preload/Node into an unprivileged guest.
    if (!normalizedSrc || !browserSessionRegistry.isAllowedPartition(partition)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    // Why: older Electron builds expose preloadURL alongside preload; delete both so the guest can't inherit the main preload bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.enableBlinkFeatures = ''
    webPreferences.disableBlinkFeatures = ''
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    // Why: force the browser guest policy even if host markup omits or misspells a preference.
    Object.assign(webPreferences, ORCA_BROWSER_GUEST_WEB_PREFERENCES)
    // Why: keep the registry-validated partition so isolated session profiles use their own storage while other hardening stays intact.
    webPreferences.partition = partition
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    // Why: attach guest popup/nav policy at creation; waiting for renderer registration races target=_blank/early redirects past it.
    browserManager.attachGuestPolicies(guest)
  })

  // Why: mirror markdown-editor focus so before-input-event skips Cmd/Ctrl+B while TipTap owns focus (docs/markdown-cmd-b-bold-design.md).
  let markdownEditorFocused = false
  let terminalInputFocused = false
  let floatingTerminalInputFocused = false
  let shortcutRecorderFocused = false

  const markdownFocusChannel = 'ui:setMarkdownEditorFocused'
  // Why: strict-bool + sender check so a guest/webview or malformed IPC payload can't disable the Cmd+B sidebar carve-out.
  const onMarkdownEditorFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    markdownEditorFocused = focused === true
  }
  ipcMain.on(markdownFocusChannel, onMarkdownEditorFocused)
  const terminalInputFocusChannel = 'ui:setTerminalInputFocused'
  // Why: before-input-event resolves shortcuts before renderer keydown; mirror xterm focus so Terminal-first lets shells own app chords.
  const onTerminalInputFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    terminalInputFocused = focused === true
  }
  ipcMain.on(terminalInputFocusChannel, onTerminalInputFocused)
  const floatingTerminalInputFocusChannel = 'ui:setFloatingTerminalInputFocused'
  // Why: before-input-event runs before renderer keydown; mirror floating xterm focus so Ctrl+B/L reach SSH/tmux.
  const onFloatingTerminalInputFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    floatingTerminalInputFocused = focused === true
  }
  ipcMain.on(floatingTerminalInputFocusChannel, onFloatingTerminalInputFocused)
  const shortcutRecorderFocusChannel = 'ui:setShortcutRecorderFocused'
  // Why: the Settings recorder must receive app shortcuts to rebind them; before-input-event would otherwise consume the key first.
  const onShortcutRecorderFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    shortcutRecorderFocused = focused === true
  }
  ipcMain.on(shortcutRecorderFocusChannel, onShortcutRecorderFocused)

  const onMainContextMenu = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
    const template = buildEditableContextMenuTemplate(params, mainWindow.webContents)
    if (template.length === 0) {
      return
    }
    // Why: the context-menu event can precede our focus-mirror update; trust Electron's editable params, not markdownEditorFocused.
    Menu.buildFromTemplate(template).popup({ window: mainWindow, x: params.x, y: params.y })
  }
  mainWindow.webContents.on('context-menu', onMainContextMenu)

  // Why: a dead renderer can't clear its focus mirror; default-deny carve-outs so it can't disable app shortcuts in a later lifecycle.
  const resetMarkdownEditorFocus = (): void => {
    markdownEditorFocused = false
  }
  const resetTerminalInputFocus = (): void => {
    terminalInputFocused = false
  }
  const resetFloatingTerminalInputFocus = (): void => {
    floatingTerminalInputFocused = false
  }
  const resetShortcutRecorderFocus = (): void => {
    shortcutRecorderFocused = false
  }
  let rendererProcessGone = false
  let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  // Why: stop a deterministic per-load renderer fault from auto-reloading forever; breaker opens after too many recoveries in a rolling window.
  const rendererRecoveryCircuitBreaker = new RendererRecoveryCircuitBreaker({
    windowMs: DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
    maxRecoveries: DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES
  })
  const clearRendererRecoveryTimer = (): void => {
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer)
      rendererRecoveryTimer = null
    }
  }
  const scheduleRendererRecovery = (details: Electron.RenderProcessGoneDetails): void => {
    if (
      rendererRecoveryTimer ||
      !details ||
      !isCrashReportReason(details.reason) ||
      windowClosing ||
      opts?.getIsQuitting?.() ||
      opts?.shouldRecoverRenderer?.(details, rendererWebContentsId) === false ||
      mainWindow.isDestroyed()
    ) {
      return
    }
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null
      if (
        windowClosing ||
        opts?.getIsQuitting?.() ||
        opts?.shouldRecoverRenderer?.(details, rendererWebContentsId) === false ||
        mainWindow.isDestroyed()
      ) {
        return
      }
      const recovery = rendererRecoveryCircuitBreaker.registerRecoveryAttempt(Date.now())
      if (!recovery.allowed) {
        // Why: too many reloads means it will just crash again; stop and let the host surface a recovery prompt.
        opts?.onRendererRecoveryExhausted?.({
          details,
          webContentsId: rendererWebContentsId,
          recentRecoveryCount: recovery.recentRecoveryCount
        })
        return
      }
      // Why: a transient renderer/Network Service loss can blank Chromium; reload the app document once to recover.
      // Why: mark this in-place reload so the did-finish-load orphan sweep spares live PTYs until session restore (#5787).
      opts?.onBeforeRecoveryReload?.(mainWindow.webContents.id)
      loadMainWindow(mainWindow)
    }, 250)
  }
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererProcessGone = true
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
    // Why: macOS reports BrowserWindow teardown as renderer killed/SIGKILL after close — window noise, not a crash.
    if (!windowClosing) {
      // Why: the recorder owns crash classification; filtering here made expected-teardown evidence unreachable.
      opts?.onRendererProcessGone?.(details, rendererWebContentsId)
    }
    if (!windowClosing) {
      console.error('[window] Renderer process gone; close confirmation will be bypassed', details)
    }
    scheduleRendererRecovery(details)
  })
  mainWindow.webContents.on('destroyed', () => {
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
  })
  mainWindow.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      resetMarkdownEditorFocus()
      resetTerminalInputFocus()
      resetFloatingTerminalInputFocus()
      resetShortcutRecorderFocus()
    }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    rendererProcessGone = false
    clearRendererRecoveryTimer()
  })

  const doubleTapDetector = new ModifierDoubleTapDetector()

  // Why: one mapping of action → IPC/side effect, shared by the keydown and double-tap paths so they can't drift.
  const sendResolvedWindowShortcutAction = (action: WindowShortcutAction): void => {
    switch (action.type) {
      // The renderer's DictationController re-checks enabled/sttModel and ignores hold mode, so this path needs no voice guards.
      case 'dictationKeyDown':
        mainWindow.webContents.send('ui:dictationKeyDown')
        return
      case 'zoom':
        mainWindow.webContents.send('terminal:zoom', action.direction)
        return
      case 'openSettings':
        mainWindow.webContents.send('ui:openSettings')
        return
      case 'forceReload':
        opts?.onBeforeReload?.({ ignoreCache: true, webContentsId: mainWindow.webContents.id })
        mainWindow.webContents.reloadIgnoringCache()
        return
      case 'toggleLeftSidebar':
        mainWindow.webContents.send('ui:toggleLeftSidebar')
        return
      case 'toggleRightSidebar':
        mainWindow.webContents.send('ui:toggleRightSidebar')
        return
      case 'toggleWorktreePalette':
        mainWindow.webContents.send('ui:toggleWorktreePalette')
        return
      case 'toggleFloatingTerminal':
        mainWindow.webContents.send('ui:toggleFloatingTerminal')
        return
      case 'openQuickOpen':
        mainWindow.webContents.send('ui:openQuickOpen')
        return
      case 'toggleQuickCommandsMenu':
        mainWindow.webContents.send('ui:toggleQuickCommandsMenu')
        return
      case 'openNewWorkspace':
        mainWindow.webContents.send('ui:openNewWorkspace')
        return
      case 'deleteCurrentWorkspace':
        mainWindow.webContents.send('ui:deleteCurrentWorkspace')
        return
      case 'openWorkspaceBoard':
        mainWindow.webContents.send('ui:openWorkspaceBoard')
        return
      case 'openTasks':
        mainWindow.webContents.send('ui:openTasks')
        return
      case 'switchRecentTab':
        mainWindow.webContents.send('ui:switchRecentTab')
        return
      case 'jumpToWorktreeIndex':
        mainWindow.webContents.send('ui:jumpToWorktreeIndex', action.index)
        return
      case 'jumpToTabIndex':
        mainWindow.webContents.send('ui:jumpToTabIndex', action.index)
        return
      case 'worktreeHistoryNavigate':
        mainWindow.webContents.send('ui:worktreeHistoryNavigate', action.direction)
    }
  }

  const dispatchResolvedWindowShortcutAction = (
    event: Electron.Event,
    action: WindowShortcutAction,
    options: {
      isAutoRepeat: boolean
      focusedShortcutContext: KeybindingMatchOptions
    }
  ): boolean => {
    const { focusedShortcutContext, isAutoRepeat } = options
    if (
      floatingTerminalInputFocused &&
      (action.type === 'toggleLeftSidebar' || action.type === 'toggleRightSidebar')
    ) {
      return false
    }

    const capturedTerminalActionId =
      focusedShortcutContext.context === 'terminal' &&
      focusedShortcutContext.terminalShortcutPolicy === 'orca-first' &&
      windowShortcutActionCapturesTerminal(action)
        ? getWindowShortcutActionId(action)
        : null

    // Why: hold-mode dictation needs renderer keyup events, so main only consumes single-keydown dictation toggles.
    if (action.type === 'dictationKeyDown') {
      const voiceSettings = store?.getSettings().voice
      if (!voiceSettings?.enabled || !voiceSettings.sttModel) {
        return false
      }
      const dictationMode = voiceSettings.dictationMode ?? 'toggle'
      if (dictationMode === 'hold') {
        return false
      }
      if (isAutoRepeat) {
        event.preventDefault()
        return true
      }
      event.preventDefault()
      if (capturedTerminalActionId) {
        mainWindow.webContents.send('ui:terminalShortcutCaptured', {
          actionId: capturedTerminalActionId
        })
      }
      mainWindow.webContents.send('ui:dictationKeyDown')
      return true
    }

    if (action.type === 'toggleQuickCommandsMenu' && isAutoRepeat) {
      event.preventDefault()
      return true
    }

    event.preventDefault()
    if (capturedTerminalActionId) {
      mainWindow.webContents.send('ui:terminalShortcutCaptured', {
        actionId: capturedTerminalActionId
      })
    }

    sendResolvedWindowShortcutAction(action)
    return true
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (shortcutRecorderFocused) {
      return
    }

    if (input.type === 'keyDown' && is.dev && input.code === 'F12') {
      event.preventDefault()
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'undocked' })
      }
      return
    }

    if (isMacAppPasteInput(input)) {
      // Why: chat/terminal panes hold focus without native editable controls, so route Cmd+V through Orca's paste ownership.
      event.preventDefault()
      mainWindow.webContents.send('ui:appMenuPaste')
      return
    }

    const keybindings = opts?.getKeybindings?.()
    const terminalShortcutContext: KeybindingMatchOptions = {
      context: terminalInputFocused || floatingTerminalInputFocused ? 'terminal' : 'app',
      terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
        store?.getSettings().terminalShortcutPolicy
      )
    }
    const appShortcutContext: KeybindingMatchOptions = {
      context: 'app',
      terminalShortcutPolicy: terminalShortcutContext.terminalShortcutPolicy
    }

    // Why: bare modifiers emit no terminal bytes, so double-tap detection on the raw key stream never steals readline input.
    if (input.type === 'keyDown' || input.type === 'keyUp') {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: input.type,
          code: input.code,
          key: input.key,
          shift: input.shift,
          control: input.control,
          alt: input.alt,
          meta: input.meta,
          isAutoRepeat: input.isAutoRepeat
        }),
        Date.now()
      )
      if (detected) {
        const doubleTapAction = resolveWindowShortcutAction(
          { type: 'keyDown', doubleTapModifier: detected.modifier },
          process.platform,
          keybindings,
          appShortcutContext
        )
        if (
          doubleTapAction &&
          dispatchResolvedWindowShortcutAction(event, doubleTapAction, {
            isAutoRepeat: false,
            focusedShortcutContext: terminalShortcutContext
          })
        ) {
          // preventDefault only the emitting keydown so the renderer detector can't also fire for the same gesture.
          return
        }
        // No allowlisted action: let the keydown reach the renderer, whose detector completes and dispatches inline.
      }
    }

    if (
      input.type === 'keyDown' &&
      matchesRecentTabSwitcherChord(input, process.platform, keybindings, terminalShortcutContext)
    ) {
      // Why: the held switcher commits on modifier keyup; preventing the keydown here can suppress the keyup and strand the overlay.
      return
    }

    // Why: TipTap owns bare Cmd/Ctrl+B for bold in the markdown editor; skip interception for the bare chord only.
    // See docs/markdown-cmd-b-bold-design.md.
    const modForBold = process.platform === 'darwin' ? input.meta : input.control
    if (
      markdownEditorFocused &&
      input.code === 'KeyB' &&
      !input.alt &&
      !input.shift &&
      modForBold
    ) {
      return
    }

    // Why: keep interception an explicit allowlist so readline control chords reach the PTY instead of being silently stolen.
    const action = resolveWindowShortcutAction(
      input,
      process.platform,
      keybindings,
      terminalShortcutContext
    )
    if (!action) {
      return
    }

    if (input.type !== 'keyDown') {
      return
    }

    dispatchResolvedWindowShortcutAction(event, action, {
      isAutoRepeat: Boolean(input.isAutoRepeat),
      focusedShortcutContext: terminalShortcutContext
    })
  })

  // Why: mid-gesture focus loss must not leave the detector armed, or the next modifier press completes a phantom double-tap.
  mainWindow.on('blur', () => doubleTapDetector.reset())

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // Why: some layouts fire Electron's zoom command without before-input-event; honor it only while the zoom action is still bound.
    if (zoomDirection !== 'in' && zoomDirection !== 'out') {
      return
    }
    if (
      !nativeZoomCommandMatchesKeybindings(
        zoomDirection,
        process.platform,
        opts?.getKeybindings?.(),
        {
          context: terminalInputFocused || floatingTerminalInputFocused ? 'terminal' : 'app',
          terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
            store?.getSettings().terminalShortcutPolicy
          )
        }
      )
    ) {
      return
    }
    event.preventDefault()
    mainWindow.webContents.send('terminal:zoom', zoomDirection)
  })

  // Intercept close so the renderer can confirm killing running-process terminals (replies window:confirm-close to proceed).
  let windowCloseConfirmed = false
  const confirmCloseChannel = 'window:confirm-close'
  const closeRequestReceivedChannel = 'window:close-request-received'
  let closeRequestSequence = 0
  let quitRendererAckRequestId: number | null = null
  let quitRendererAckTimer: ReturnType<typeof setTimeout> | null = null
  const clearQuitRendererAckTimer = (): void => {
    quitRendererAckRequestId = null
    if (quitRendererAckTimer) {
      clearTimeout(quitRendererAckTimer)
      quitRendererAckTimer = null
    }
  }
  const armQuitRendererAckTimer = (requestId: number): void => {
    quitRendererAckRequestId = requestId
    if (quitRendererAckTimer) {
      return
    }
    // Why: will-quit cannot run until the renderer-backed window closes; an
    // already-frozen renderer otherwise makes Force Quit the only escape.
    quitRendererAckTimer = setTimeout(() => {
      quitRendererAckTimer = null
      quitRendererAckRequestId = null
      if (mainWindow.isDestroyed()) {
        return
      }
      console.warn('[window] Renderer did not acknowledge quit; destroying unresponsive window')
      freezeBoundsOnQuit()
      mainWindow.destroy()
    }, WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS)
    quitRendererAckTimer.unref?.()
  }
  const onCloseRequestReceived = (event: Electron.IpcMainEvent, requestId: number): void => {
    if (event.sender.id === rendererWebContentsId && requestId === quitRendererAckRequestId) {
      clearQuitRendererAckTimer()
    }
  }

  // Windows minimize-to-tray: hide instead of close when enabled; returns true when it hid so callers skip their close path.
  const hideToTrayIfEnabled = (): boolean => {
    const isRendererCrashed = mainWindow.webContents.isCrashed?.() ?? false
    if (
      process.platform !== 'win32' ||
      rendererProcessGone ||
      isRendererCrashed ||
      opts?.getIsQuitting?.() === true ||
      store?.getSettings().minimizeToTrayOnClose !== true
    ) {
      return false
    }
    mainWindow.hide()
    // Why: notify once that closing only hid the window; the persisted flag stops it repeating on every later minimize.
    if (store.getUI().trayMinimizeNoticeShown !== true) {
      try {
        new Notification({
          title: 'Orca',
          body: translateMain(
            'tray.minimizeNotice.body',
            'Orca is still running in the system tray'
          )
        }).show()
      } catch {
        // Notification is best-effort — never block hiding the window.
      }
      store.updateUI({ trayMinimizeNoticeShown: true })
    }
    return true
  }

  mainWindow.on('close', (e) => {
    // Why: Alt+F4/programmatic closes hit the native event; apply the same minimize-to-tray guard the renderer-drawn X uses.
    if (!windowCloseConfirmed && hideToTrayIfEnabled()) {
      e.preventDefault()
      return
    }
    const isRendererCrashed = mainWindow.webContents.isCrashed?.() ?? false
    // Why: only a gone/crashed renderer (can't answer) may bypass close confirmation; a hung-but-alive one still must (#5787).
    const closeAction = resolveWindowCloseAction({
      windowCloseConfirmed,
      rendererProcessGone,
      isRendererCrashed
    })
    if (closeAction !== 'request-confirmation') {
      // allow-confirmed: renderer already replied and re-entered close().
      // bypass-gone: a gone renderer can't answer window:close-requested, so let OS close complete rather than trap a blank window.
      if (closeAction === 'allow-confirmed') {
        windowCloseConfirmed = false
      }
      // Why: window teardown emits resize/move/unmaximize; freeze bounds persistence so they can't clobber saved size (v1.3.26-rc2).
      windowClosing = true
      if (boundsTimer) {
        clearTimeout(boundsTimer)
        boundsTimer = null
      }
      return
    }
    e.preventDefault()
    const isQuitting = opts?.getIsQuitting?.() ?? false
    const requestId = ++closeRequestSequence
    if (isQuitting) {
      armQuitRendererAckTimer(requestId)
    }
    // Why: renderer owns the close decision; the always-mounted App root subscription lets even pre-workspace states reply (#5144).
    mainWindow.webContents.send('window:close-requested', {
      isQuitting,
      requestId
    })
  })
  mainWindow.webContents.on('will-prevent-unload', () => {
    // Why: a prevented beforeunload cancels the quit; release the bounds-persistence freeze so later resizing still saves.
    windowClosing = false
    clearQuitRendererAckTimer()
    opts?.onQuitAborted?.()
    mainWindow.webContents.send('window:unload-prevented')
  })

  const onConfirmClose = (): void => {
    clearQuitRendererAckTimer()
    windowCloseConfirmed = true
    if (!mainWindow.isDestroyed()) {
      mainWindow.close()
    }
  }
  const trafficLightChannel = 'ui:sync-traffic-lights'
  const onSyncTrafficLights = (_event: Electron.IpcMainEvent, zoomFactor: number): void => {
    syncTrafficLightPosition(mainWindow, zoomFactor)
  }
  ipcMain.on(trafficLightChannel, onSyncTrafficLights)

  // Why: renderer-drawn window controls on Windows/Linux replicate the native title-bar buttons hidden by custom chrome.
  const minimizeChannel = 'window:minimize'
  const onMinimize = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.minimize()
    }
  }
  const maximizeChannel = 'window:maximize'
  const onMaximize = (): void => {
    if (mainWindow.isDestroyed()) {
      return
    }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
  // Why: mainWindow.close() from an IPC handler on Windows can make 'close' misfire, so send window:close-requested directly.
  const requestCloseChannel = 'window:request-close'
  const onRequestClose = (): void => {
    if (mainWindow.isDestroyed()) {
      return
    }
    // Why: renderer-drawn X routes here (not the native close event), so the minimize-to-tray guard must also run here.
    if (hideToTrayIfEnabled()) {
      return
    }
    mainWindow.webContents.send('window:close-requested', { isQuitting: false })
  }
  // Why: renderer-drawn title-bar ··· menu button replicates the Alt-key reveal autoHideMenuBar provides (Windows/Linux).
  const popupMenuChannel = 'menu:popup'
  const onPopupMenu = (): void => {
    Menu.getApplicationMenu()?.popup({ window: mainWindow })
  }
  // Why: WindowControls mounts after window:maximize-changed already fired, so expose a synchronous getter to init its icon.
  const isMaximizedChannel = 'window:isMaximized'
  const onIsMaximized = (): boolean => {
    return !mainWindow.isDestroyed() && mainWindow.isMaximized()
  }
  ipcMain.on(minimizeChannel, onMinimize)
  ipcMain.on(maximizeChannel, onMaximize)
  ipcMain.on(requestCloseChannel, onRequestClose)
  ipcMain.on(popupMenuChannel, onPopupMenu)
  ipcMain.handle(isMaximizedChannel, onIsMaximized)

  ipcMain.on(confirmCloseChannel, onConfirmClose)
  ipcMain.on(closeRequestReceivedChannel, onCloseRequestReceived)
  mainWindow.on('closed', () => {
    // Why: the dashboard pop-out is a companion of the main window — close it
    // alongside so it never orphans as a lone window after the app window is
    // gone (e.g. on macOS where the app stays alive after the window closes).
    closeDashboardPopout()
    clearInitialRevealFallbackTimer()
    clearQuitRendererAckTimer()
    // Why: default-deny the Cmd+B carve-out after the window is gone so a stale-true flag can't leak into later state.
    markdownEditorFocused = false
    terminalInputFocused = false
    floatingTerminalInputFocused = false
    shortcutRecorderFocused = false
    clearRendererRecoveryTimer()
    ipcMain.removeListener(trafficLightChannel, onSyncTrafficLights)
    ipcMain.removeListener(minimizeChannel, onMinimize)
    ipcMain.removeListener(maximizeChannel, onMaximize)
    browserManager.setDictationShortcutForwardingPredicate(null)
    ipcMain.removeListener(requestCloseChannel, onRequestClose)
    ipcMain.removeListener(popupMenuChannel, onPopupMenu)
    ipcMain.removeHandler(isMaximizedChannel)
    ipcMain.removeListener(confirmCloseChannel, onConfirmClose)
    ipcMain.removeListener(closeRequestReceivedChannel, onCloseRequestReceived)
    ipcMain.removeListener(markdownFocusChannel, onMarkdownEditorFocused)
    ipcMain.removeListener(terminalInputFocusChannel, onTerminalInputFocused)
    ipcMain.removeListener(floatingTerminalInputFocusChannel, onFloatingTerminalInputFocused)
    ipcMain.removeListener(shortcutRecorderFocusChannel, onShortcutRecorderFocused)
    // Why: powerMonitor is app-global; without this the resume relay leaks and fires against a destroyed webContents.
    powerMonitor.removeListener('resume', onSystemResume)
    clearTrustedUIRendererWebContentsId(rendererWebContentsId)
    // Why: on updater shutdown 'closed' can fire after webContents is destroyed, so don't touch mainWindow.webContents here.
    app.removeListener('before-quit', freezeBoundsOnQuit)
  })

  if (!opts?.deferLoad) {
    loadMainWindow(mainWindow)
  }

  return mainWindow
}
