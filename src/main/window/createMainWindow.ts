/* oxlint-disable max-lines */
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import devIcon from '../../../resources/icon-dev.png?asset'
import type { Store } from '../persistence'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
import { resolveWindowShortcutAction } from '../../shared/window-shortcut-policy'
import { getMainE2EConfig } from '../e2e-config'
import { buildEditableContextMenuTemplate } from './editable-context-menu'

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
    show: false,
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
    icon: is.dev ? devIcon : icon,
    ...platformBlurOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webviewTag: true
    }
  })

  if (process.platform === 'darwin') {
    // Why: persistent parked webviews use separate compositor layers, and on
    // recent macOS releases those layers can fail to repaint after occlusion or
    // restore. Disabling main-window throttling and forcing a repaint on
    // visibility transitions hardens Orca against the same black-surface
    // failure mode seen during browser-tab restore and tab switching.
    mainWindow.webContents.setBackgroundThrottling(false)
    mainWindow.on('restore', () => {
      forceRepaint(mainWindow)
    })
    mainWindow.on('show', () => {
      forceRepaint(mainWindow)
    })
  }

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
  mainWindow.on('ready-to-show', () => {
    if (handledInitialReadyToShow) {
      return
    }
    handledInitialReadyToShow = true

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
  })

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
  // Cmd+B — terminal and browser-guest focus still get sidebar-toggle, which
  // preserves the ^B-to-PTY leak protection rationale in
  // shared/window-shortcut-policy.ts:74-77.
  let markdownEditorFocused = false

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
  // Default-deny the carve-out so Cmd+B falls back to sidebar-toggle, which is
  // the safe behavior when focus context is unknown. Preserves the
  // ^B-to-PTY leak invariant from shared/window-shortcut-policy.ts:74-77.
  const resetMarkdownEditorFocus = (): void => {
    markdownEditorFocused = false
  }
  mainWindow.webContents.on('render-process-gone', resetMarkdownEditorFocus)
  mainWindow.webContents.on('destroyed', resetMarkdownEditorFocus)
  mainWindow.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      resetMarkdownEditorFocus()
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    if (is.dev && input.code === 'F12') {
      event.preventDefault()
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'undocked' })
      }
      return
    }

    // Why: TipTap owns bare Cmd/Ctrl+B for bold while the markdown editor is
    // focused — skip interception so its keymap runs. Scoped to the bare chord
    // (no Shift/Alt): any extra modifier signals different intent and must
    // still resolve through the policy allowlist. Other focus contexts
    // (terminal, browser guest) still get sidebar-toggle because ^B would
    // otherwise reach xterm.js / guest webContents.
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
    const action = resolveWindowShortcutAction(input, process.platform)
    if (!action) {
      return
    }

    event.preventDefault()

    if (action.type === 'zoom') {
      mainWindow.webContents.send('terminal:zoom', action.direction)
      return
    }

    if (action.type === 'toggleLeftSidebar') {
      mainWindow.webContents.send('ui:toggleLeftSidebar')
      return
    }

    if (action.type === 'toggleRightSidebar') {
      mainWindow.webContents.send('ui:toggleRightSidebar')
      return
    }

    if (action.type === 'toggleWorktreePalette') {
      // Why: embedded browser guests can keep keyboard focus inside Chromium's
      // guest webContents, which bypasses the renderer's window-level keydown
      // listener. Forward the worktree-switch shortcut through the main window
      // so Cmd+J (macOS) or Ctrl+Shift+J (Win/Linux) works consistently from browser tabs too.
      mainWindow.webContents.send('ui:toggleWorktreePalette')
      return
    }

    if (action.type === 'openQuickOpen') {
      // Forward Cmd/Ctrl+P to trigger Quick Open
      mainWindow.webContents.send('ui:openQuickOpen')
      return
    }

    if (action.type === 'openNewWorkspace') {
      // Why: routed through the main process so focus contexts that bypass
      // the renderer's window-level keydown (contentEditable markdown editor,
      // browser-guest webContents) still reach the new-workspace composer.
      mainWindow.webContents.send('ui:openNewWorkspace')
      return
    }

    if (action.type === 'jumpToWorktreeIndex') {
      // Forward Cmd/Ctrl+1-9 for quick worktree switching
      mainWindow.webContents.send('ui:jumpToWorktreeIndex', action.index)
      return
    }

    if (action.type === 'worktreeHistoryNavigate') {
      // Why: routed through main so the chord reaches the renderer even when
      // a terminal (xterm.js) or a browser guest has focus — both surfaces
      // otherwise absorb Arrow keys before the renderer's window listener.
      mainWindow.webContents.send('ui:worktreeHistoryNavigate', action.direction)
    }
  })

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // Why: Some keyboard layouts/platforms consume Ctrl/Cmd+Minus before
    // before-input-event fires, but still emit Electron's zoom command. We
    // reroute that command to terminal zoom so zoom-out remains reachable.
    event.preventDefault()
    if (zoomDirection === 'in') {
      mainWindow.webContents.send('terminal:zoom', 'in')
    } else if (zoomDirection === 'out') {
      mainWindow.webContents.send('terminal:zoom', 'out')
    }
  })

  // Intercept window close so the renderer can show a confirmation dialog
  // when terminals with running processes would be killed. The renderer
  // replies with 'window:confirm-close' to proceed, or does nothing to cancel.
  let windowCloseConfirmed = false
  const confirmCloseChannel = 'window:confirm-close'

  mainWindow.on('close', (e) => {
    if (windowCloseConfirmed) {
      windowCloseConfirmed = false
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

  // Why: renderer-drawn window controls on Windows send these to replicate the
  // native title bar buttons that 'hidden' titleBarStyle removes.
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
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:close-requested', { isQuitting: false })
    }
  }
  // Why: the ··· button in the renderer-drawn title bar on Windows pops up
  // the application menu at the cursor position, replicating the Alt-key
  // reveal that autoHideMenuBar normally provides.
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
    // Why: default-deny the Cmd+B carve-out after the window is gone so a
    // stale-true flag can't leak past subsequent state transitions. Paired
    // with the webContents lifecycle resets above.
    markdownEditorFocused = false
    ipcMain.removeListener(trafficLightChannel, onSyncTrafficLights)
    ipcMain.removeListener(minimizeChannel, onMinimize)
    ipcMain.removeListener(maximizeChannel, onMaximize)
    ipcMain.removeListener(requestCloseChannel, onRequestClose)
    ipcMain.removeListener(popupMenuChannel, onPopupMenu)
    ipcMain.removeHandler(isMaximizedChannel)
    ipcMain.removeListener(confirmCloseChannel, onConfirmClose)
    ipcMain.removeListener(markdownFocusChannel, onMarkdownEditorFocused)
    mainWindow.webContents.removeListener('context-menu', onMainContextMenu)
    app.removeListener('before-quit', freezeBoundsOnQuit)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
