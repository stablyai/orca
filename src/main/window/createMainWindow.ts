import { app, BrowserWindow, nativeTheme, powerMonitor, screen } from 'electron'
import { join } from 'node:path'
import { getAppIconPath } from '../app-icon'
import { browserManager } from '../browser/browser-manager'
import { getBrowserClientHostId } from '../browser/browser-client-host-id'
import { formatBrowserClientHostIdArgument } from '../../shared/browser-client-host-id-argument'
import { markSystemSessionEnding } from '../crash-reporting/expected-teardown-state'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { clearTrustedUIRendererWebContentsId, setTrustedUIRendererWebContentsId } from '../ipc/ui'
import { flushUnsavedCloudSessions } from '../orca-profiles/profile-cloud-session-owner'
import type { Store } from '../persistence'
import { closeDashboardPopout } from './dashboard-popout-window'
import { closeWorkspaceSpaceWindow } from './workspace-space-window'
import { closeAllDetachedTerminalWindows } from './detached-terminal-window'
import {
  installMainWindowCloseLifecycle,
  WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS
} from './main-window-close-lifecycle'
import type { CreateMainWindowOptions, MainWindowLoadObserver } from './main-window-contracts'
import { mainWindowLoadErrorCode } from './main-window-load-error-code'
import { installMainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import { installMainWindowShortcutRouting } from './main-window-shortcut-routing'
import { installMainWindowStateLifecycle } from './main-window-state-lifecycle'
import { stopHiddenWindowFramePumpOnShow } from './hidden-window-frame-pump'
import { wslHostsWindowArguments } from '../wsl/wsl-host-gate'
import {
  formatHiddenWindowFramePumpArgument,
  shouldPumpHiddenWindowFrames
} from '../../shared/hidden-window-frame-pump'
import {
  forceRepaint,
  installMacosVisibilityRepaint,
  MIN_HEIGHT,
  MIN_WIDTH,
  TITLEBAR_CSS_CENTER,
  TRAFFIC_LIGHT_RADIUS,
  TRAFFIC_LIGHT_X
} from './main-window-visual-lifecycle'
import { installMainWindowWebviewSecurity } from './main-window-webview-security'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { installWindowsPathRegistryChangeListener } from '../pty/windows-path-registry-change'
import { recordAgentSessionRuntimeEnd } from '../runtime/agent-session-runtime-end-record'

export { WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS }

export function loadMainWindow(mainWindow: BrowserWindow, observer?: MainWindowLoadObserver): void {
  const load =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
      : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  // Observe each load promise so failures cannot leave recovery waiting silently.
  load.then(
    () => observer?.onLoaded?.(),
    (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      const errorCode = mainWindowLoadErrorCode(error)
      // Keep durable diagnostics path-free and exclude shutdown/navigation aborts.
      if (!mainWindow.isDestroyed() && errorCode !== 'ERR_ABORTED') {
        recordDurableCrashBreadcrumb('main_window_load_failed', { errorCode })
      }
      console.error('[window] Main window load failed', error)
      observer?.onError?.(error)
    }
  )
}

export function createMainWindow(
  store: Store | null,
  opts?: CreateMainWindowOptions
): BrowserWindow {
  const rawSavedBounds = store?.getUI().windowBounds
  // Reject tiny/off-screen saved bounds so the titlebar stays reachable after display changes.
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
  // Fill the primary work area on first launch; later launches honor saved bounds.
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
    // Webview guests have no safe transcript target; yield the dictation shortcut to the page.
    return false
  })
  const blur = settings?.windowBackgroundBlur ?? false
  // Only Windows acrylic is visible; macOS transparency adds WindowServer compositing behind opaque content (#8482). Creation-time only.
  const platformBlurOptions =
    blur && process.platform === 'win32' ? { backgroundMaterial: 'acrylic' as const } : {}

  const pumpHiddenFrames = shouldPumpHiddenWindowFrames(process.env, process.platform)
  const mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? defaultBounds.width,
    height: savedBounds?.height ?? defaultBounds.height,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: opts?.title ?? 'Orca',
    show: false,
    // Deliver the app-activating click on macOS instead of requiring a second click.
    acceptFirstMouse: true,
    // Save menu-bar space on Windows/Linux; Alt reveals it and macOS uses the system menu.
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    // Keep macOS traffic lights inset; hide Windows native chrome to avoid duplicate titlebars.
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : undefined,
    // Linux ignores hidden titleBarStyle; remove its native frame to avoid duplicate titlebars.
    ...(process.platform === 'linux' ? { frame: false } : {}),
    // Start at 1x traffic-light position; syncTrafficLightPosition follows zoom.
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
      webviewTag: true,
      // Pass host identity at birth so the renderer has it before first snapshot, without waiting for IPC registration.
      additionalArguments: [
        formatBrowserClientHostIdArgument(getBrowserClientHostId()),
        ...(pumpHiddenFrames ? [formatHiddenWindowFramePumpArgument()] : []),
        ...wslHostsWindowArguments()
      ]
    }
  })
  const rendererWebContentsId = mainWindow.webContents.id
  installWindowsPathRegistryChangeListener(mainWindow)
  // Native paste fallback is privileged; trust only the top-level renderer.
  setTrustedUIRendererWebContentsId(rendererWebContentsId)

  // Unlike query-session-end, session-end cannot be canceled before this signal is recorded.
  if (process.platform === 'win32') {
    mainWindow.on('session-end', (event) => {
      markSystemSessionEnding()
      // Record positive OS shutdown evidence; task-kill and shutdown tree deaths otherwise look identical.
      recordDurableCrashBreadcrumb('system_session_end', {
        reasons: Array.isArray(event?.reasons)
          ? event.reasons.filter((reason) => typeof reason === 'string').join(',')
          : ''
      })
      flushUnsavedCloudSessions()
      // Windows emits no will-quit for an OS shutdown or logoff, so its teardown never records it.
      recordAgentSessionRuntimeEnd('quit')
    })
  }

  if (process.platform === 'darwin') {
    // Keep hidden-window throttling; native sizing/frame invalidation recovers wake without an active viewport.
    mainWindow.webContents.setBackgroundThrottling(true)
    installMacosVisibilityRepaint(mainWindow)
  }

  // Resume may preserve focus and emit no visibility events; explicitly relay terminal wake and repaint stale surfaces.
  const onSystemResume = (): void => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed?.() === true) {
      return
    }
    forceRepaint(mainWindow)
    mainWindow.webContents.send('system:resumed')
    // Give a suspended recovery load its full budget on wake.
    focus.notifySystemResume()
  }

  const state = installMainWindowStateLifecycle({
    mainWindow,
    revealOnDidFinishLoad: opts?.revealOnDidFinishLoad === true,
    savedMaximized,
    store
  })
  installMainWindowWebviewSecurity(mainWindow)
  if (pumpHiddenFrames) {
    stopHiddenWindowFramePumpOnShow(mainWindow)
  }
  const focus = installMainWindowFocusLifecycle({
    isWindowClosing: state.isWindowClosing,
    mainWindow,
    opts,
    reloadMainWindow: (observer) => loadMainWindow(mainWindow, observer),
    rendererWebContentsId
  })
  // Register after focus is initialized because the resume callback uses it.
  powerMonitor.on('resume', onSystemResume)
  installMainWindowShortcutRouting({ focus, mainWindow, opts, store })
  const closeLifecycle = installMainWindowCloseLifecycle({
    focus,
    mainWindow,
    opts,
    rendererWebContentsId,
    state,
    store
  })

  mainWindow.on('closed', () => {
    closeDashboardPopout()
    closeWorkspaceSpaceWindow()
    closeAllDetachedTerminalWindows()
    state.clearInitialRevealFallbackTimer()
    closeLifecycle.dispose()
    focus.dispose()
    browserManager.setDictationShortcutForwardingPredicate(null)
    powerMonitor.removeListener('resume', onSystemResume)
    clearTrustedUIRendererWebContentsId(rendererWebContentsId)
    state.dispose()
  })

  if (!opts?.deferLoad) {
    loadMainWindow(mainWindow)
  }

  return mainWindow
}
