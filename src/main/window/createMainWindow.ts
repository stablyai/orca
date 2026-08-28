import { BrowserWindow, nativeTheme, powerMonitor, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { getAppIconPath } from '../app-icon'
import { browserManager } from '../browser/browser-manager'
import { getBrowserClientHostId } from '../browser/browser-client-host-id'
import { formatBrowserClientHostIdArgument } from '../../shared/browser-client-host-id-argument'
import { markSystemSessionEnding } from '../crash-reporting/expected-teardown-state'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { clearTrustedUIRendererWebContentsId, setTrustedUIRendererWebContentsId } from '../ipc/ui'
import type { Store } from '../persistence'
import { closeDashboardPopout } from './dashboard-popout-window'
import {
  installMainWindowCloseLifecycle,
  WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS
} from './main-window-close-lifecycle'
import type { CreateMainWindowOptions } from './main-window-contracts'
import { installMainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import { installMainWindowShortcutRouting } from './main-window-shortcut-routing'
import { installMainWindowStateLifecycle } from './main-window-state-lifecycle'
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

export { WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS }

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
  // Why: only Windows acrylic is ever visible; macOS vibrancy+transparent sat behind our opaque background yet
  // forced per-frame WindowServer alpha compositing (#8482). Applies at creation only, so it needs a restart.
  const platformBlurOptions =
    blur && process.platform === 'win32' ? { backgroundMaterial: 'acrylic' as const } : {}

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
      webviewTag: true,
      // Why an argument and not an IPC read: this is the window whose webviews host browser guests,
      // and it has to know that before it interprets its first session snapshot — earlier than any
      // handler registration it could wait on.
      additionalArguments: [formatBrowserClientHostIdArgument(getBrowserClientHostId())]
    }
  })
  const rendererWebContentsId = mainWindow.webContents.id
  installWindowsPathRegistryChangeListener(mainWindow)
  // Why: native paste fallback is privileged IPC; only the top-level renderer may request it.
  setTrustedUIRendererWebContentsId(rendererWebContentsId)

  // Unlike query-session-end, session-end cannot be canceled before this signal is recorded.
  if (process.platform === 'win32') {
    mainWindow.on('session-end', (event) => {
      markSystemSessionEnding()
      // Why: killed/exit-1 tree kills look identical from a user task-kill and an
      // OS shutdown; this is the only positive OS-shutdown signal bundles get.
      recordDurableCrashBreadcrumb('system_session_end', {
        reasons: Array.isArray(event?.reasons)
          ? event.reasons.filter((reason) => typeof reason === 'string').join(',')
          : ''
      })
    })
  }

  if (process.platform === 'darwin') {
    // Why: preserve hidden-window power savings; stable native sizing and frame-only invalidation
    // make wake recovery independent of the throttled viewport.
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

  const state = installMainWindowStateLifecycle({
    mainWindow,
    revealOnDidFinishLoad: opts?.revealOnDidFinishLoad === true,
    savedMaximized,
    store
  })
  installMainWindowWebviewSecurity(mainWindow)
  const focus = installMainWindowFocusLifecycle({
    isWindowClosing: state.isWindowClosing,
    mainWindow,
    opts,
    reloadMainWindow: () => loadMainWindow(mainWindow),
    rendererWebContentsId
  })
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
