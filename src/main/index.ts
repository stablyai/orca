import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import devIcon from '../../resources/icon-dev.png?asset'
import { Store, initDataPath } from './persistence'
import { StatsCollector, initStatsPath } from './stats/collector'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { killAllPty } from './ipc/pty'
import { initDaemonPtyProvider, disconnectDaemon } from './daemon/daemon-init'
import { closeAllWatchers } from './ipc/filesystem-watcher'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { triggerStartupNotificationRegistration } from './ipc/notifications'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { registerAppMenu } from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from './updater'
import {
  configureDevUserDataPath,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentWatchdog,
  installUncaughtPipeErrorGuard,
  patchPackagedProcessPath
} from './startup/configure-process'
import { RateLimitService } from './rate-limits/service'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow } from './window/createMainWindow'
import { CodexAccountService } from './codex-accounts/service'
import { openCodeHookService } from './opencode/hook-service'

let mainWindow: BrowserWindow | null = null
/** Whether a manual app.quit() (Cmd+Q, etc.) is in progress. Shared with the
 *  window close handler so it can tell the renderer to skip the running-process
 *  confirmation dialog and proceed directly to buffer capture + close. */
let isQuitting = false
let store: Store | null = null
let stats: StatsCollector | null = null
let claudeUsage: ClaudeUsageStore | null = null
let codexUsage: CodexUsageStore | null = null
let codexAccounts: CodexAccountService | null = null
let runtime: OrcaRuntimeService | null = null
let rateLimits: RateLimitService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null

installUncaughtPipeErrorGuard()
patchPackagedProcessPath()
configureDevUserDataPath(is.dev)
installDevParentDisconnectQuit(is.dev)
installDevParentWatchdog(is.dev)
// Why: must run after configureDevUserDataPath (which redirects userData to
// orca-dev in dev mode) but before app.setName('Orca') inside whenReady
// (which would change the resolved path on case-sensitive filesystems).
initDataPath()
// Why: same timing constraint as initDataPath — capture the userData path
// before app.setName changes it. See persistence.ts:20-28.
initStatsPath()
initClaudeUsagePath()
initCodexUsagePath()
enableMainProcessGpuFeatures()

function openMainWindow(): BrowserWindow {
  if (!store) {
    throw new Error('Store must be initialized before opening the main window')
  }
  if (!runtime) {
    throw new Error('Runtime must be initialized before opening the main window')
  }
  if (!stats) {
    throw new Error('Stats must be initialized before opening the main window')
  }
  if (!claudeUsage) {
    throw new Error('Claude usage store must be initialized before opening the main window')
  }
  if (!codexUsage) {
    throw new Error('Codex usage store must be initialized before opening the main window')
  }
  if (!rateLimits) {
    throw new Error('Rate limit service must be initialized before opening the main window')
  }
  if (!codexAccounts) {
    throw new Error('Codex account service must be initialized before opening the main window')
  }

  const window = createMainWindow(store, {
    getIsQuitting: () => isQuitting,
    onQuitAborted: () => {
      isQuitting = false
    }
  })
  registerCoreHandlers(
    store,
    runtime,
    stats,
    claudeUsage,
    codexUsage,
    codexAccounts,
    rateLimits,
    window.webContents.id
  )
  attachMainWindowServices(window, store, runtime, () =>
    codexAccounts!.getSelectedManagedHomePath()
  )
  rateLimits.attach(window)
  rateLimits.start()
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
  mainWindow = window
  return window
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.stablyai.orca')
  app.setName('Orca')

  if (process.platform === 'darwin' && is.dev) {
    const dockIcon = nativeImage.createFromPath(devIcon)
    app.dock?.setIcon(dockIcon)
  }

  store = new Store()
  stats = new StatsCollector()
  claudeUsage = new ClaudeUsageStore(store)
  codexUsage = new CodexUsageStore(store)
  rateLimits = new RateLimitService()
  codexAccounts = new CodexAccountService(store, rateLimits)
  rateLimits.setCodexHomePathResolver(() => codexAccounts!.getSelectedManagedHomePath())
  runtime = new OrcaRuntimeService(store, stats)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  registerAppMenu({
    onCheckForUpdates: () => checkForUpdatesFromMenu(),
    onOpenSettings: () => {
      mainWindow?.webContents.send('ui:openSettings')
    },
    onZoomIn: () => {
      mainWindow?.webContents.send('terminal:zoom', 'in')
    },
    onZoomOut: () => {
      mainWindow?.webContents.send('terminal:zoom', 'out')
    },
    onZoomReset: () => {
      mainWindow?.webContents.send('terminal:zoom', 'reset')
    },
    onToggleStatusBar: () => {
      mainWindow?.webContents.send('ui:toggleStatusBar')
    }
  })
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: app.getPath('userData')
  })

  // Why: daemon must start before openMainWindow because registerPtyHandlers
  // (called inside) relies on the provider already being set. Starting it
  // alongside the other parallel servers keeps cold-start latency flat.
  await initDaemonPtyProvider()

  // Why: both server binds are independent and neither blocks window creation.
  // Parallelizing them with the window open shaves ~100-200ms off cold start.
  const [win] = await Promise.all([
    Promise.resolve(openMainWindow()),
    openCodeHookService.start().catch((error) => {
      console.error('[opencode] Failed to start local hook server:', error)
    }),
    runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start local RPC transport:', error)
    })
  ])

  // Why: the macOS notification permission dialog must fire after the window
  // is visible and focused. If it fires before the window exists, the system
  // dialog either doesn't appear or gets immediately covered by the maximized
  // window, making it impossible for the user to click "Allow".
  win.once('show', () => {
    triggerStartupNotificationRegistration(store!)
  })

  app.on('activate', () => {
    // Don't re-open a window while Squirrel's ShipIt is replacing the .app
    // bundle.  Without this guard the old version gets resurrected and the
    // update never applies.
    if (BrowserWindow.getAllWindows().length === 0 && !isQuittingForUpdate()) {
      openMainWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  // Why: PTY cleanup is deferred to will-quit so the renderer has a chance to
  // capture terminal scrollback buffers before PTY exit events race in and
  // unmount TerminalPane components (removing their capture callbacks).
  // The window close handler passes isQuitting to the renderer so it skips the
  // child-process confirmation dialog and proceeds directly to buffer capture.
  rateLimits?.stop()
})

app.on('will-quit', () => {
  // Why: stats.flush() must run before killAllPty() so it can read the
  // live agent state and emit synthetic agent_stop events for agents that
  // are still running. killAllPty() does not call runtime.onPtyExit(),
  // so without this ordering, running agents would produce orphaned
  // agent_start events with no matching stops.
  openCodeHookService.stop()
  stats?.flush()
  killAllPty()
  // Why: in daemon mode, killAllPty is a no-op (daemon sessions survive app
  // quit) but the client connection must be closed so sockets are released.
  // disconnectDaemon only tears down the client transport — it does NOT kill
  // the daemon process or mark its history as cleanly ended, preserving both
  // warm reattach and crash recovery on next launch.
  disconnectDaemon()
  void closeAllWatchers()
  if (runtimeRpc) {
    void runtimeRpc.stop().catch((error) => {
      console.error('[runtime] Failed to stop local RPC transport:', error)
    })
  }
  store?.flush()
})

app.on('window-all-closed', () => {
  // Why: on macOS, closing all windows normally keeps the app alive (dock
  // stays active). But when a quit is in progress (Cmd+Q), the window close
  // handler defers to the renderer for buffer capture, which cancels the
  // original quit sequence. Re-trigger quit here so the app actually exits
  // instead of requiring a second Cmd+Q.
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit()
  }
})
