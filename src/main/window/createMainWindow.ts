/* oxlint-disable max-lines */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  shell
} from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { Store } from '../persistence'
import { getAppIconPath } from '../app-icon'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { translateMain } from '../i18n/main-i18n'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
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

function forceRepaint(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }
  window.webContents.invalidate()
  if (window.isMaximized() || window.isFullScreen()) {
    return
  }
  const [width, height] = window.getSize()
  window.setSize(width + 1, height)
  setTimeout(() => {
    if (!window.isDestroyed()) {
      window.setSize(width, height)
    }
  }, 32)
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

// Why: the titlebar is 36px (border-box, 1px border-bottom).  The visual
// center of the CSS-centered content sits at ~18 CSS px from the top.
// At zoom factor z that becomes 18·z window px.  Traffic lights are
// ~12px tall, so we position their top edge at (center − 6).
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
  /** Returns true when a manual app.quit() (Cmd+Q) is in progress. The close
   *  handler sends this to the renderer so it can skip the running-process
   *  confirmation dialog and proceed directly to buffer capture + close. */
  getIsQuitting?: () => boolean
  /** Notifies the caller when the renderer vetoes unload. Why: a prevented
   *  beforeunload cancels the in-flight app.quit(), so the app-level quit
   *  latch must be cleared or later window closes will be misclassified as
   *  quit attempts. */
  onQuitAborted?: () => void
  onRendererProcessGone?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => void
  /** Returns true when a renderer loss should be reported as a crash. Why:
   *  intentional reload/update/quit paths can emit crash-like `killed`
   *  renderer exits, but surfacing those as crash reports is noise. */
  shouldRecordRendererCrash?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => boolean
  /** Returns true when Orca should reload after an unexpected renderer loss.
   *  Why: update relaunch and app quit intentionally tear down child
   *  processes; recovering those paths can fight Electron's shutdown. */
  shouldRecoverRenderer?: (
    details: Electron.RenderProcessGoneDetails,
    webContentsId: number
  ) => boolean
  /** Called when consecutive auto-recoveries hit the circuit-breaker limit, so
   *  the host can record diagnostics and surface a recovery prompt instead of
   *  letting Orca crash-loop. */
  onRendererRecoveryExhausted?: (info: {
    details: Electron.RenderProcessGoneDetails
    webContentsId: number
    recentRecoveryCount: number
  }) => void
  /** Why: main-process startup must register IPC handlers before the renderer
   *  begins booting, or eager renderer calls can race into missing channels. */
  deferLoad?: boolean
  title?: string
  getKeybindings?: () => KeybindingOverrides | undefined
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /** Why: the in-place renderer-recovery reload re-fires did-finish-load, whose
   *  local-PTY orphan sweep would kill live sessions across the single window
   *  before session restore re-attaches them (#5787). This callback lets the host
   *  mark that one reload so the sweep can be skipped for it. */
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
  // Why: defense in depth — if a previous quit/update path persisted
  // shrink-to-min bounds (see freezeBoundsOnQuit), discard them on restore
  // rather than resurrecting a tiny window. Anything at or below the min
  // dimensions is treated as corrupt and falls back to defaultBounds. The
  // position must also land on a currently-attached display with a
  // *meaningful* visible area — not just any >0 overlap, since a 1-pixel
  // sliver (or a sub-pixel shaving after DPI scaling) would still leave
  // the titlebar unreachable. Require at least MIN_WIDTH/2 of horizontal
  // and MIN_HEIGHT/2 of vertical overlap with some display's workArea
  // (workArea excludes menu bar / dock, so a rect entirely hidden under
  // the dock is also correctly discarded). A rect saved while an external
  // monitor was connected would otherwise be restored off-screen and
  // macOS would silently shrink/reposition the window.
  const rectHasVisibleAreaOnAnyDisplay = (b: {
    x: number
    y: number
    width: number
    height: number
  }): boolean => {
    try {
      return screen.getAllDisplays().some((d) => {
        const wa = d.workArea
        const overlapX = Math.max(0, Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x))
        const overlapY = Math.max(
          0,
          Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
        )
        return overlapX >= MIN_WIDTH / 2 && overlapY >= MIN_HEIGHT / 2
      })
    } catch (err) {
      console.warn('[window] screen.getAllDisplays() threw; treating bounds as off-screen', err)
      return false
    }
  }
  const savedBounds =
    rawSavedBounds &&
    rawSavedBounds.width > MIN_WIDTH &&
    rawSavedBounds.height > MIN_HEIGHT &&
    rectHasVisibleAreaOnAnyDisplay(rawSavedBounds)
      ? rawSavedBounds
      : undefined
  if (rawSavedBounds && !savedBounds) {
    console.warn(
      '[window] Discarding persisted windowBounds and falling back to defaultBounds:',
      rawSavedBounds
    )
  }
  const savedMaximized = store?.getUI().windowMaximized ?? false
  // Why: on first launch (no saved bounds), fill the primary display work area
  // so the window feels spacious without calling maximize(). Saved bounds still
  // win on subsequent launches.
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
    // Why: focused webview guests do not expose a safe transcript insertion
    // target yet. Let Cmd/Ctrl+E continue to the page instead of starting a
    // dictation session whose final text would be dropped.
    return false
  })
  const blur = settings?.windowBackgroundBlur ?? false
  // Why: native blur requires platform-specific Electron APIs. macOS uses
  // vibrancy (needs transparent: true), Windows uses backgroundMaterial.
  // Linux has no native equivalent. Blur only applies at window creation;
  // changing the setting requires a restart.
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
    // Why: macOS swallows the app-activating click by default, so clicking
    // back into Orca (e.g. the floating workspace) needed a second click.
    // macOS-only option; Windows/Linux already deliver that click.
    acceptFirstMouse: true,
    // Why: on macOS the menu lives in the system menu bar, so the in-window
    // menu bar is irrelevant. On Windows/Linux we auto-hide so the menu bar
    // doesn't consume a dedicated row of vertical space on every launch —
    // users can still reveal the (properly restructured) File/Edit/View/
    // Window/Help menus by pressing Alt, matching native Windows/Linux
    // conventions (File Explorer, Firefox, etc.).
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    // Why: on macOS 'hiddenInset' keeps the native traffic lights positioned
    // inside our custom 42px titlebar. On Windows 'hidden' removes the default
    // OS title bar (which would otherwise stack on top of our renderer titlebar
    // and waste vertical space) while still allowing our renderer to draw its
    // own drag region and window controls.
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : undefined,
    // Why: Linux ignores titleBarStyle: 'hidden', so without this the native
    // WM title bar stays and stacks on top of our renderer titlebar (double
    // title bar). frame: false drops the native frame; the renderer draws its
    // own titlebar + window controls (see WindowControls in App.tsx), matching
    // the Windows custom-titlebar path.
    ...(process.platform === 'linux' ? { frame: false } : {}),
    // Why: initial position for 1x zoom; syncTrafficLightPosition() adjusts
    // dynamically when the user changes UI zoom.
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
  // Why: native paste fallback is privileged IPC; only the real top-level
  // renderer should be allowed to request Electron's native paste operation.
  setTrustedUIRendererWebContentsId(rendererWebContentsId)

  if (process.platform === 'darwin') {
    // Why: persistent browser webviews use separate compositor layers, and on
    // recent macOS releases those layers can fail to repaint after occlusion or
    // restore. Disabling main-window throttling and forcing a repaint on
    // visibility transitions hardens Orca against black-surface failures during
    // browser-tab restore and tab switching.
    mainWindow.webContents.setBackgroundThrottling(false)
    mainWindow.on('restore', () => {
      forceRepaint(mainWindow)
    })
    mainWindow.on('show', () => {
      forceRepaint(mainWindow)
    })
  }

  // Why: a focus-preserving system/display wake fires no window focus or
  // visibility events in the renderer, so terminal wake recovery would never
  // run. Relay powerMonitor resume explicitly (supported on mac/win/linux)
  // and force a repaint so stale compositor surfaces recover too.
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
    // Why: the native traffic lights sit at a fixed position in the window
    // while CSS content scales with zoom.  We must reposition the buttons
    // on startup so they stay vertically aligned with the zoomed titlebar.
    if (process.platform === 'darwin') {
      syncTrafficLightPosition(mainWindow, Math.pow(1.2, level))
    }
  })

  // Why: on macOS + Electron 41, creating a webview guest process can re-emit
  // ready-to-show on the same BrowserWindow. Without a one-shot guard the
  // handler re-runs maximize() from the persisted savedMaximized flag, snapping
  // the window back to full-screen after the user already resized it (#591).
  let handledInitialReadyToShow = false
  let initialRevealFallbackTimer: ReturnType<typeof setTimeout> | null =
    process.platform === 'win32'
      ? setTimeout(() => {
          // Why: GPU/driver failures on Windows can prevent ready-to-show forever,
          // leaving the only app window hidden while the main process stays alive.
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

    // Why: in E2E headless mode, the window stays hidden to avoid stealing
    // focus and screen real estate during test runs. Playwright interacts
    // with the renderer via CDP, which works without a visible window.
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

  // Why: persist window bounds so the app restores to the user's last
  // position/size instead of maximizing on every launch. Debounce to avoid
  // hammering the persistence layer during continuous resize drags.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  // Why: once close has been initiated (user Cmd+Q, auto-updater relaunch,
  // app.quit during quitAndInstall), Electron can still emit resize/move/
  // unmaximize events while the OS tears the window down — persisting those
  // intermediate, often near-minimum bounds would clobber the user's real
  // last-used size and cause the next launch (especially post-update
  // relaunch) to come up at minWidth × minHeight. Freeze persistence as soon
  // as 'close' is observed.
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
      // Why: windowMaximized and windowBounds must be sampled and persisted
      // atomically — writing windowMaximized first and then deciding whether
      // to write bounds can leave the store with `windowMaximized: false`
      // paired with stale/absent windowBounds if the near-min guard trips,
      // which violates the pairing invariant subsequent launches rely on.
      const isMaximized = mainWindow.isMaximized()
      if (isMaximized) {
        store?.updateUI({ windowMaximized: true })
        return
      }
      const bounds = mainWindow.getBounds()
      // Why: never persist shrink-to-min bounds. The user cannot want these
      // saved — the window hit the enforced minimum, so either the teardown
      // race from PR #1269 slipped past the freeze (e.g. dev-mode Ctrl+C
      // where will-prevent-unload re-opens the freeze), or a transient
      // OS resize fired. Dropping the bounds write here makes the next
      // launch fall back to defaultBounds instead of resurrecting a tiny
      // window. We still record windowMaximized: false so subsequent
      // launches don't incorrectly restore maximized state.
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

  // Why: the auto-updater install path calls
  // `win.removeAllListeners('close')` before quitting, so the per-window
  // 'close' handler below never runs for update-triggered relaunches.
  // Listen to app-level 'before-quit' as a second latch so resize/move
  // events emitted during window teardown don't persist shrink-to-min
  // bounds that would be restored on next launch.
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
    // Why: mirror the saveBounds guard — unmaximize during teardown can land
    // at MIN_WIDTH × MIN_HEIGHT and we must not persist those as the user's
    // remembered size.
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const externalUrl = normalizeExternalBrowserUrl(details.url)
    if (externalUrl) {
      shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''

    // Why: arbitrary sites must stay inside an unprivileged guest surface. We
    // fail closed here so a renderer bug cannot smuggle preload, Node, or a
    // non-browser partition into the guest and widen the app privilege boundary.
    // The one allowed data URL is Orca's inert blank-tab bootstrap page; deny
    // every other data URL so the renderer cannot inject arbitrary inline HTML.
    // Why: session profiles use per-profile partitions (e.g.
    // persist:orca-browser-session-<uuid>). The registry is the sole authority
    // for which partitions are valid — renderer-provided strings that are not
    // in the allowlist are rejected.
    if (!normalizedSrc || !browserSessionRegistry.isAllowedPartition(partition)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    // Why: older Electron builds expose preloadURL alongside preload; delete
    // both so the guest surface cannot inherit the main preload bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.enableBlinkFeatures = ''
    webPreferences.disableBlinkFeatures = ''
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    // Why: keep renderer-created webviews aligned with the browser guest policy
    // even if the host markup omits or misspells a preference.
    Object.assign(webPreferences, ORCA_BROWSER_GUEST_WEB_PREFERENCES)
    // Why: preserve the registry-validated partition instead of forcing the
    // legacy constant. This lets imported/isolated session profiles use their
    // own cookie/storage partition while keeping all other hardening intact.
    webPreferences.partition = partition
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    // Why: popup and navigation policy must attach as soon as Chromium creates
    // the guest webContents. Waiting until renderer-driven registration leaves
    // a race where target=_blank or early redirects can bypass Orca's intended
    // fallback behavior.
    browserManager.attachGuestPolicies(guest)
  })

  // Block ALL in-window navigations to prevent remote pages from inheriting
  // the privileged preload bridge (PTY, filesystem, etc.).
  // In dev mode, allow navigations to the local dev server (e.g. HMR reloads).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const externalUrl = normalizeExternalBrowserUrl(url)

    if (externalUrl) {
      const target = new URL(externalUrl)
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        try {
          const allowed = new URL(process.env.ELECTRON_RENDERER_URL)
          if (target.origin === allowed.origin) {
            return // allow dev server navigations (HMR, etc.)
          }
        } catch {
          // fall through to prevent
        }
      }

      shell.openExternal(externalUrl)
    }

    event.preventDefault()
  })

  // Why: mirrors the renderer's markdown-editor focus state so the main-process
  // before-input-event handler can skip Cmd/Ctrl+B interception while TipTap
  // owns focus. See docs/markdown-cmd-b-bold-design.md. We only carve out
  // Cmd+B so browser guests and other editable surfaces keep the existing
  // global shortcut behavior.
  let markdownEditorFocused = false
  let terminalInputFocused = false
  let floatingTerminalInputFocused = false
  let shortcutRecorderFocused = false

  const markdownFocusChannel = 'ui:setMarkdownEditorFocused'
  // Why: coerce to strict boolean and verify the sender. A renderer bug or
  // compromised IPC payload must not set the flag to a truthy non-bool (e.g.
  // an object) and silently disable the sidebar toggle — default-deny on any
  // non-bool. Additionally, only this main window's top-level webContents may
  // mutate the flag, so a guest/webview or unrelated sender can't disable the
  // Cmd+B sidebar carve-out.
  const onMarkdownEditorFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    markdownEditorFocused = focused === true
  }
  ipcMain.on(markdownFocusChannel, onMarkdownEditorFocused)
  const terminalInputFocusChannel = 'ui:setTerminalInputFocused'
  // Why: before-input-event resolves shortcuts before renderer keydown. Mirror
  // regular xterm focus so Terminal-first can let shells/TUIs own app chords.
  const onTerminalInputFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    terminalInputFocused = focused === true
  }
  ipcMain.on(terminalInputFocusChannel, onTerminalInputFocused)
  const floatingTerminalInputFocusChannel = 'ui:setFloatingTerminalInputFocused'
  // Why: main before-input-event runs before renderer keydown handlers. Mirror
  // floating xterm focus so Ctrl+B/L and related shell chords can reach SSH/tmux.
  const onFloatingTerminalInputFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    floatingTerminalInputFocused = focused === true
  }
  ipcMain.on(floatingTerminalInputFocusChannel, onFloatingTerminalInputFocused)
  const shortcutRecorderFocusChannel = 'ui:setShortcutRecorderFocused'
  // Why: the Settings recorder must receive existing app shortcuts so users can
  // rebind them; before-input-event would otherwise consume the key first.
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
    // Why: right-click can produce a Chromium context-menu event before our
    // renderer focus mirror updates, so trust Electron's editable/spellcheck
    // params here instead of gating on markdownEditorFocused.
    Menu.buildFromTemplate(template).popup({ window: mainWindow, x: params.x, y: params.y })
  }
  mainWindow.webContents.on('context-menu', onMainContextMenu)

  // Why: renderer can't mirror focus state across a crash/reload/close.
  // Default-deny the carve-outs so focus context from a dead renderer cannot
  // disable app shortcuts in a later lifecycle state.
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
  // Why: stop a deterministic per-load renderer fault (bad GPU driver, corrupt
  // chunk, AV interference) from auto-reloading every ~0.25-1.3s forever
  // (Windows crash-loop clusters). The breaker opens after too many recoveries
  // inside a rolling window and hands off to the host's recovery surface.
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
        // Why: too many reloads in the window means reloading again will just
        // crash again. Stop the loop and let the host surface a recovery prompt.
        opts?.onRendererRecoveryExhausted?.({
          details,
          webContentsId: rendererWebContentsId,
          recentRecoveryCount: recovery.recentRecoveryCount
        })
        return
      }
      // Why: a transient Network Service / renderer loss can leave Chromium
      // showing a blank shell. Reload the app document once so the user gets
      // back to a usable window instead of needing a full relaunch.
      // Why: mark this one in-place reload so the did-finish-load orphan sweep
      // spares live local PTYs until session restore re-attaches them (#5787).
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
    // Why: macOS can report BrowserWindow teardown as renderer `killed`/SIGKILL
    // after a confirmed close; that is window lifecycle noise, not a crash.
    if (
      !windowClosing &&
      opts?.shouldRecordRendererCrash?.(details, rendererWebContentsId) !== false
    ) {
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

  // Why: one place maps a resolved window-shortcut action to its IPC/side effect,
  // reused by the normal keydown path and the double-tap path so they cannot drift.
  const sendResolvedWindowShortcutAction = (action: WindowShortcutAction): void => {
    switch (action.type) {
      // The renderer's DictationController re-checks enabled/sttModel and ignores
      // hold mode, so this path needs no voice guards.
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

    // Why: hold-mode dictation needs renderer keyup events, so the main process
    // may only consume shortcuts that toggle dictation from a single keydown.
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
      // Why: native chat/terminal panes can own focus without being native
      // editable controls, so route Cmd+V through Orca's paste ownership first.
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

    // Why: detect double-tap-modifier gestures on the raw key stream. A bare
    // modifier emits no terminal bytes, so this never steals readline input.
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
          // Only preventDefault the emitting keydown — never the first tap's
          // down/up. This suppresses the renderer DOM keydown so the renderer
          // detector cannot also fire for the same gesture.
          return
        }
        // No allowlisted action: let the keydown reach the renderer, whose
        // detector completes and dispatches inline.
      }
    }

    if (
      input.type === 'keyDown' &&
      matchesRecentTabSwitcherChord(input, process.platform, keybindings, terminalShortcutContext)
    ) {
      // Why: the held switcher commits on modifier keyup. If main prevents the
      // keydown, Electron can suppress the renderer keyup and strand the overlay.
      return
    }

    // Why: TipTap owns bare Cmd/Ctrl+B for bold while the markdown editor is
    // focused — skip interception so its keymap runs. Scoped to the bare chord
    // (no Shift/Alt): any extra modifier signals different intent and must
    // still resolve through the policy allowlist.
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

    // Why: keep the main-process interception surface as an explicit allowlist.
    // Anything outside this helper must continue to the renderer/PTTY so
    // readline control chords are not silently stolen above the terminal.
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

  // Why: a mid-gesture focus loss must not leave the detector armed so the next
  // unrelated modifier press completes a phantom double-tap.
  mainWindow.on('blur', () => doubleTapDetector.reset())

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // Why: Some keyboard layouts/platforms consume Ctrl/Cmd+Minus before
    // before-input-event fires, but still emit Electron's zoom command. Keep
    // that fallback only while the matching zoom action is still bound.
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

  // Intercept window close so the renderer can show a confirmation dialog
  // when terminals with running processes would be killed. The renderer
  // replies with 'window:confirm-close' to proceed, or does nothing to cancel.
  let windowCloseConfirmed = false
  const confirmCloseChannel = 'window:confirm-close'

  // Why: Windows minimize-to-tray. Hides the window instead of closing when the
  // setting is on, this isn't a real quit (Ctrl+Q / tray "Quit" set
  // getIsQuitting), and the renderer is alive. Returns true when it handled the
  // close by hiding, so callers skip their normal close path. Shared by BOTH the
  // renderer-drawn X (window:request-close) and the native close event (Alt+F4).
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
    // Why: tell the user once that closing only hid the window; the persisted
    // flag stops the notice from repeating on every later minimize.
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
    // Why: Alt+F4 and programmatic closes reach the native event; apply the same
    // minimize-to-tray guard the renderer-drawn X uses via onRequestClose.
    if (!windowCloseConfirmed && hideToTrayIfEnabled()) {
      e.preventDefault()
      return
    }
    const isRendererCrashed = mainWindow.webContents.isCrashed?.() ?? false
    // Why: a hung-but-ALIVE renderer (neither gone nor crashed) must still hit
    // the renderer's save/running-process confirmation; only a genuinely gone or
    // crashed renderer — which cannot answer window:close-requested — may bypass
    // it. Routing this through the pure decision locks that invariant (#5787).
    const closeAction = resolveWindowCloseAction({
      windowCloseConfirmed,
      rendererProcessGone,
      isRendererCrashed
    })
    if (closeAction !== 'request-confirmation') {
      // allow-confirmed: the renderer already replied and re-entered close().
      // bypass-gone: after a native renderer crash the renderer cannot answer
      // window:close-requested, so let Cmd+Q / OS close complete instead of
      // trapping the user in a blank, unquittable window.
      if (closeAction === 'allow-confirmed') {
        windowCloseConfirmed = false
      }
      // Why: past this point Electron/OS may emit resize/move/unmaximize as
      // the window is destroyed. Freeze bounds persistence so those
      // teardown events can't clobber the user's saved window size — which
      // would otherwise make the post-update relaunch come up at minWidth ×
      // minHeight (issue surfaced in v1.3.26-rc2).
      windowClosing = true
      if (boundsTimer) {
        clearTimeout(boundsTimer)
        boundsTimer = null
      }
      return
    }
    e.preventDefault()
    // Why: the renderer owns the close decision (dirty-file save dialogs,
    // running-process confirmation). The subscription lives at the always-
    // mounted App root, so even pre-workspace states reply — see #5144.
    mainWindow.webContents.send('window:close-requested', {
      isQuitting: opts?.getIsQuitting?.() ?? false
    })
  })
  mainWindow.webContents.on('will-prevent-unload', () => {
    // Why: a prevented beforeunload cancels the in-flight quit. Release the
    // bounds-persistence freeze so a user who keeps using the window after
    // aborting Cmd+Q still gets their size saved.
    windowClosing = false
    opts?.onQuitAborted?.()
  })

  const onConfirmClose = (): void => {
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

  // Why: renderer-drawn window controls on Windows/Linux desktop send these to
  // replicate the native title bar buttons hidden by custom chrome.
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
  // Why: send window:close-requested directly rather than calling
  // mainWindow.close() and letting the 'close' event re-send it. Calling
  // mainWindow.close() from within an IPC message handler on Windows can cause
  // the 'close' event to misfire (e.preventDefault() doesn't suppress the OS
  // close in all Windows configurations). Going straight to the renderer's
  // close guard (Terminal.tsx onWindowCloseRequested) keeps the flow identical
  // to what happens when confirmWindowClose() ultimately calls mainWindow.close()
  // with windowCloseConfirmed = true.
  const requestCloseChannel = 'window:request-close'
  const onRequestClose = (): void => {
    if (mainWindow.isDestroyed()) {
      return
    }
    // Why: the renderer-drawn X on Windows routes here (not the native close
    // event), so the minimize-to-tray guard must run on this path too — hide
    // instead of asking the renderer to close.
    if (hideToTrayIfEnabled()) {
      return
    }
    mainWindow.webContents.send('window:close-requested', { isQuitting: false })
  }
  // Why: the ··· button in the renderer-drawn title bar on Windows/Linux
  // desktop pops up the application menu at the cursor position, replicating
  // the Alt-key reveal that autoHideMenuBar normally provides.
  const popupMenuChannel = 'menu:popup'
  const onPopupMenu = (): void => {
    Menu.getApplicationMenu()?.popup({ window: mainWindow })
  }
  // Why: the renderer's WindowControls mounts after ready-to-show, which is
  // also when savedMaximized is restored — so window:maximize-changed has
  // already fired (or not fired, if maximize() was called pre-mount) before
  // the listener attaches. Expose a synchronous getter so the button can
  // initialize its icon to match the current state on mount.
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
  mainWindow.on('closed', () => {
    clearInitialRevealFallbackTimer()
    // Why: default-deny the Cmd+B carve-out after the window is gone so a
    // stale-true flag can't leak past subsequent state transitions. Paired
    // with the webContents lifecycle resets above.
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
    ipcMain.removeListener(markdownFocusChannel, onMarkdownEditorFocused)
    ipcMain.removeListener(terminalInputFocusChannel, onTerminalInputFocused)
    ipcMain.removeListener(floatingTerminalInputFocusChannel, onFloatingTerminalInputFocused)
    ipcMain.removeListener(shortcutRecorderFocusChannel, onShortcutRecorderFocused)
    // Why: powerMonitor is app-global; without this the closed window's
    // resume relay would leak and fire against a destroyed webContents.
    powerMonitor.removeListener('resume', onSystemResume)
    clearTrustedUIRendererWebContentsId(rendererWebContentsId)
    // Why: on updater-triggered shutdown, BrowserWindow can emit `closed`
    // after its webContents has already been destroyed. The destroyed
    // webContents owns its listeners, so do not touch `mainWindow.webContents`
    // here or the quit path can crash before Squirrel.Mac relaunches Orca.
    app.removeListener('before-quit', freezeBoundsOnQuit)
  })

  if (!opts?.deferLoad) {
    loadMainWindow(mainWindow)
  }

  return mainWindow
}
