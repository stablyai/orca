/* eslint-disable max-lines -- Why: this is Orca's main-process entry point;
   it owns app lifecycle, service wiring, window creation, and hook/daemon
   startup. Splitting by line count would fragment tightly coupled startup
   logic across files without a cleaner ownership seam. */
import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import devIcon from '../../resources/icon-dev.png?asset'
import { Store, initDataPath } from './persistence'
import { StatsCollector, initStatsPath } from './stats/collector'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { killAllPty } from './ipc/pty'
import {
  initDaemonPtyProvider,
  disconnectDaemon,
  cleanupOrphanedDaemon
} from './daemon/daemon-init'
import { recordPendingDaemonTransitionNotice, setAppRuntimeFlags } from './ipc/app'
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
import { hydrateShellPath, mergePathSegments } from './startup/hydrate-shell-path'
import { RateLimitService } from './rate-limits/service'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow } from './window/createMainWindow'
import { CodexAccountService } from './codex-accounts/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import { StarNagService } from './star-nag/service'
import { agentHookServer } from './agent-hooks/server'
import { claudeHookService } from './claude/hook-service'
import { codexHookService } from './codex/hook-service'
import { geminiHookService } from './gemini/hook-service'
import { AGENT_DASHBOARD_ENABLED } from '../shared/constants'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { browserManager } from './browser/browser-manager'

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
let codexRuntimeHome: CodexRuntimeHomeService | null = null
let claudeAccounts: ClaudeAccountService | null = null
let claudeRuntimeAuth: ClaudeRuntimeAuthService | null = null
let runtime: OrcaRuntimeService | null = null
let rateLimits: RateLimitService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null
let starNag: StarNagService | null = null

installUncaughtPipeErrorGuard()
// Why: propagate the Orca app version into `process.env` so PTY-env
// construction in both main (local-pty-provider) and the forked daemon
// (pty-subprocess) can set `TERM_PROGRAM_VERSION` without re-importing
// electron. The daemon inherits `process.env` via fork (daemon-init.ts:93).
process.env.ORCA_APP_VERSION = app.getVersion()
patchPackagedProcessPath()
// Why: patchPackagedProcessPath seeds a minimal list of well-known system
// dirs synchronously so early IPC (e.g. preflight before the shell spawn
// completes) doesn't miss homebrew/nix. Kick off the login-shell probe in
// parallel for packaged runs — when it resolves, its PATH is prepended and
// detectInstalledAgents picks up whatever the user's rc files put on PATH
// (cargo/pyenv/volta/custom tool install dirs) without hardcoding each one.
// Dev runs already inherit a complete PATH from the launching terminal, so
// the spawn cost is only paid where it's needed.
if (app.isPackaged && process.platform !== 'win32') {
  void hydrateShellPath().then((result) => {
    if (result.ok) {
      mergePathSegments(result.segments)
    }
  })
}
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
  if (!codexRuntimeHome) {
    throw new Error('Codex runtime home service must be initialized before opening the main window')
  }
  if (!claudeAccounts) {
    throw new Error('Claude account service must be initialized before opening the main window')
  }
  if (!claudeRuntimeAuth) {
    throw new Error(
      'Claude runtime auth service must be initialized before opening the main window'
    )
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
    claudeAccounts,
    rateLimits,
    window.webContents.id
  )
  attachMainWindowServices(
    window,
    store,
    runtime,
    () => codexRuntimeHome!.prepareForCodexLaunch(),
    () => claudeRuntimeAuth!.prepareForClaudeLaunch()
  )
  rateLimits.attach(window)
  rateLimits.start()
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
    if (AGENT_DASHBOARD_ENABLED) {
      // Why: detach the agent hook listener on window close so the server
      // never fires into a destroyed webContents during the gap before
      // reopen (e.g. macOS dock re-activation). This also ensures the
      // replay-loop through lastStatusByPaneKey runs only on deliberate
      // window recreations instead of stacking on top of stale listeners.
      agentHookServer.setListener(null)
    }
  })
  mainWindow = window
  if (AGENT_DASHBOARD_ENABLED) {
    agentHookServer.setListener(({ paneKey, tabId, worktreeId, payload }) => {
      if (mainWindow?.isDestroyed()) {
        return
      }
      mainWindow?.webContents.send('agentStatus:set', {
        paneKey,
        tabId,
        worktreeId,
        ...payload
      })
    })
  }
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
  codexRuntimeHome = new CodexRuntimeHomeService(store)
  codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome)
  claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver(() => codexRuntimeHome!.prepareForRateLimitFetch())
  rateLimits.setClaudeAuthPreparationResolver(() => claudeRuntimeAuth!.prepareForRateLimitFetch())
  runtime = new OrcaRuntimeService(store, stats)
  starNag = new StarNagService(store, stats)
  starNag.start()
  starNag.registerIpcHandlers()
  runtime.setAgentBrowserBridge(new AgentBrowserBridge(browserManager))
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why: managed hook installation mutates user-global agent config.
  // Startup must fail open so a malformed local config never bricks Orca.
  if (AGENT_DASHBOARD_ENABLED) {
    for (const installManagedHooks of [
      () => claudeHookService.install(),
      () => codexHookService.install(),
      () => geminiHookService.install()
    ]) {
      try {
        installManagedHooks()
      } catch (error) {
        console.error('[agent-hooks] Failed to install managed hooks:', error)
      }
    }
  }

  registerAppMenu({
    onCheckForUpdates: (options) => checkForUpdatesFromMenu(options),
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

  // Why: persistent terminal sessions (the out-of-process daemon) are gated
  // behind an experimental setting that defaults to OFF. Users on v1.3.0 had
  // the daemon on by default, so on upgrade we may need to clean up a live
  // daemon from their previous session before continuing with the local
  // provider. `registerPtyHandlers` (called inside openMainWindow) relies on
  // the provider being set, so whichever branch runs must complete first.
  const daemonEnabled = store.getSettings().experimentalTerminalDaemon === true
  let daemonStarted = false
  if (daemonEnabled) {
    // Why: catch so the app still opens even if the daemon fails. The local
    // PTY provider remains as the fallback — terminals will still work, just
    // without cross-restart persistence.
    try {
      await initDaemonPtyProvider()
      daemonStarted = true
    } catch (error) {
      console.error('[daemon] Failed to start daemon PTY provider, falling back to local:', error)
    }
  } else {
    // Why: stash the cleanup result so the renderer's one-shot transition
    // toast can tell the user how many background sessions were stopped. Only
    // record when `cleaned: true` — i.e. an orphan daemon was actually found.
    // Fresh installs (no socket) skip the toast entirely.
    try {
      const result = await cleanupOrphanedDaemon()
      if (result.cleaned) {
        recordPendingDaemonTransitionNotice({ killedCount: result.killedCount })
      }
    } catch (error) {
      console.error('[daemon] Failed to clean up orphaned daemon:', error)
    }
  }
  setAppRuntimeFlags({ daemonEnabledAtStartup: daemonStarted })

  if (AGENT_DASHBOARD_ENABLED) {
    try {
      // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from the live server state.
      // Start the hook server before opening the window so restored/spawned
      // terminals never race ahead without hook env on first launch.
      await agentHookServer.start({ env: app.isPackaged ? 'production' : 'development' })
    } catch (error) {
      // Why: Claude/Codex/Gemini/OpenCode hook callbacks are sidebar
      // enrichment only. Orca must still boot even if the local loopback
      // receiver cannot bind on this launch.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  }

  // Why: once the hook server is ready (or has already failed open), window
  // creation and runtime RPC startup are independent.
  const [win] = await Promise.all([
    Promise.resolve(openMainWindow()),
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
  starNag?.stop()
  if (AGENT_DASHBOARD_ENABLED) {
    agentHookServer.stop()
  }
  stats?.flush()
  // Why: agent-browser daemon processes would otherwise linger after Orca quits,
  // holding ports and leaving stale session state on disk.
  runtime?.getAgentBrowserBridge()?.destroyAllSessions()
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
