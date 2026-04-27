/* eslint-disable max-lines -- Why: this is Orca's main-process entry point;
   it owns app lifecycle, service wiring, window creation, and hook/daemon
   startup. Splitting by line count would fragment tightly coupled startup
   logic across files without a cleaner ownership seam. */
import { grantDirAcl } from './win32-utils'
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
import { cursorHookService } from './cursor/hook-service'
import { getPtyIdForPaneKey, registerPaneKeyTeardownListener } from './ipc/pty'
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

  // Why: Chromium's BrowserWindow constructor resets the userData DACL to a
  // Protected DACL. Grant explicit Full Control ACEs on all existing children
  // before the constructor runs so they survive the upcoming DACL reset.
  // Per-write EPERM retries in fs-utils/installer-utils serve as the backstop
  // for any directories created after startup.
  if (process.platform === 'win32') {
    try {
      grantDirAcl(app.getPath('userData'), { recursive: true })
    } catch {
      // Non-fatal; per-call retries are the backstop.
    }
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
    // Why: detach the agent hook listener on window close so the server
    // never fires into a destroyed webContents during the gap before
    // reopen (e.g. macOS dock re-activation). This also ensures the
    // replay-loop through lastStatusByPaneKey runs only on deliberate
    // window recreations instead of stacking on top of stale listeners.
    agentHookServer.setListener(null)
    // Why: any running cursor spinner intervals would fire into a destroyed
    // webContents; stop them all here instead of deferring to per-pane
    // teardown, which may never run for restored-but-never-torn-down panes
    // when the window goes away.
    // Why: stopCursorSpinner deletes only the current entry, which the Map
    // iterator handles safely — no snapshot copy needed.
    for (const paneKey of cursorSpinnerByPaneKey.keys()) {
      stopCursorSpinner(paneKey)
    }
  })
  mainWindow = window
  agentHookServer.setListener(({ paneKey, tabId, worktreeId, payload }) => {
    if (mainWindow?.isDestroyed()) {
      return
    }
    if (AGENT_DASHBOARD_ENABLED) {
      mainWindow?.webContents.send('agentStatus:set', {
        paneKey,
        tabId,
        worktreeId,
        ...payload
      })
    }
    // Why: cursor-agent emits no title-based working/idle signal — its OSC
    // title stays "Cursor Agent" for the whole turn. Synthesize an OSC title
    // update from the hook state and inject it into the pane's data stream so
    // the existing renderer-side title tracker (the one that drives the
    // sidebar spinner, unread badge, and Claude prompt-cache timer for every
    // other agent) lights up for cursor panes too. Braille prefix ⠋ → working
    // keyword path; "action required" keyword → permission; bare label → idle.
    // This runs regardless of AGENT_DASHBOARD_ENABLED because cursor has no
    // pre-dashboard title heuristic to fall back to.
    if (payload.agentType === 'cursor') {
      driveCursorPaneFromHook(paneKey, payload.state)
    }
  })
  return window
}

// Why: Pi-style persistent spinner — cursor-agent re-emits its own
// "Cursor Agent" OSC title on every internal redraw, so a single synthesized
// "⠋ Cursor Agent" frame gets silently overwritten in the renderer within
// milliseconds and the sidebar dot snaps back to solid. Keep asserting a
// fresh working frame on an interval until the hook reports a non-working
// state. Interval matches Pi's 80ms cadence — fast enough for a smooth
// spinner, slow enough to stay well under the per-flush IPC budget.
const CURSOR_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const CURSOR_SPINNER_INTERVAL_MS = 80
const cursorSpinnerByPaneKey = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; frame: number }
>()

// Why: on PTY teardown the paneKey→ptyId mapping is dropped, so the spinner
// interval would keep firing but sendCursorTitle would no-op forever. Stop
// the interval explicitly so the process doesn't carry a timer per dead pane.
registerPaneKeyTeardownListener((paneKey) => {
  stopCursorSpinner(paneKey)
})

function sendCursorTitle(ptyId: string, data: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('pty:data', { id: ptyId, data })
}

function stopCursorSpinner(paneKey: string): void {
  const entry = cursorSpinnerByPaneKey.get(paneKey)
  if (entry) {
    clearInterval(entry.timer)
    cursorSpinnerByPaneKey.delete(paneKey)
  }
}

function driveCursorPaneFromHook(paneKey: string, state: string): void {
  const ptyId = getPtyIdForPaneKey(paneKey)
  if (!ptyId) {
    return
  }
  if (state === 'working') {
    // Why: immediately emit the first frame so the spinner starts visible at
    // this hook event even if the interval's next tick is 80ms away. Subsequent
    // frames come from the interval below.
    const existing = cursorSpinnerByPaneKey.get(paneKey)
    const frame = existing ? existing.frame : 0
    sendCursorTitle(ptyId, `\x1b]0;${CURSOR_SPINNER_FRAMES[frame]} Cursor Agent\x07`)
    if (existing) {
      return
    }
    const timer = setInterval(() => {
      const ptyIdNow = getPtyIdForPaneKey(paneKey)
      if (!ptyIdNow) {
        stopCursorSpinner(paneKey)
        return
      }
      const cur = cursorSpinnerByPaneKey.get(paneKey)
      if (!cur) {
        return
      }
      cur.frame = (cur.frame + 1) % CURSOR_SPINNER_FRAMES.length
      sendCursorTitle(ptyIdNow, `\x1b]0;${CURSOR_SPINNER_FRAMES[cur.frame]} Cursor Agent\x07`)
    }, CURSOR_SPINNER_INTERVAL_MS)
    cursorSpinnerByPaneKey.set(paneKey, { timer, frame })
    return
  }
  // Why: leaving the spinner running after a `blocked`/`waiting`/`done` event
  // would immediately race the terminal state back to "working" on the next
  // tick. Stop first, then inject the terminal frame. Idle/done uses a
  // decorated "Cursor ready" label rather than the bare native "Cursor Agent"
  // — which the detector deliberately treats as a no-op so cursor's own
  // per-turn re-emissions cannot clobber our synthesized state. The
  // done/permission frames also carry a trailing BEL (0x07 outside of any OSC
  // sequence) because cursor-agent does not emit one on its own — and the
  // tab-level unread badge + notification dispatch in pty-connection keys off
  // BEL, not the working→idle title transition.
  stopCursorSpinner(paneKey)
  const synthetic =
    state === 'blocked' || state === 'waiting'
      ? '\x1b]0;Cursor - action required\x07\x07'
      : '\x1b]0;Cursor ready\x07\x07'
  sendCursorTitle(ptyId, synthetic)
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
  // Claude/Codex/Gemini installs are gated behind AGENT_DASHBOARD_ENABLED
  // because the surface they feed (the in-progress agent dashboard) isn't
  // shippable yet. Cursor installs unconditionally because cursor-agent
  // emits no title-based working/idle signal at all (its terminal title
  // stays literally "Cursor Agent" across a turn), so the hook channel is
  // the only way to drive the sidebar spinner + unread path for it — there
  // is no "pre-dashboard" fallback to degrade to the way Claude/Codex have.
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
  try {
    cursorHookService.install()
  } catch (error) {
    console.error('[agent-hooks] Failed to install Cursor managed hooks:', error)
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

  // Why: the hook server also runs unconditionally so cursor-agent panes can
  // reach it. Claude/Codex/Gemini hook scripts stay uninstalled while
  // AGENT_DASHBOARD_ENABLED is false, so only cursor events flow in. PTY
  // spawn env reads ORCA_AGENT_HOOK_* from the live server state, so the
  // server must start before the window opens — otherwise restored terminals
  // race ahead without the env on first launch.
  try {
    await agentHookServer.start({ env: app.isPackaged ? 'production' : 'development' })
  } catch (error) {
    // Why: Claude/Codex/Gemini/OpenCode/Cursor hook callbacks are sidebar
    // enrichment only. Orca must still boot even if the local loopback
    // receiver cannot bind on this launch.
    console.error('[agent-hooks] Failed to start local hook server:', error)
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

// Why: will-quit fires twice when daemon disconnect needs an async flush.
// First pass: run all sync cleanup, then preventDefault to await the final
// checkpoint writes. Second pass (after disconnect resolves): skip the
// async work and let Electron exit.
let daemonDisconnectDone = false
app.on('will-quit', (e) => {
  // Why: stats.flush() must run before killAllPty() so it can read the
  // live agent state and emit synthetic agent_stop events for agents that
  // are still running. killAllPty() does not call runtime.onPtyExit(),
  // so without this ordering, running agents would produce orphaned
  // agent_start events with no matching stops.
  starNag?.stop()
  agentHookServer.stop()
  stats?.flush()
  // Why: agent-browser daemon processes would otherwise linger after Orca quits,
  // holding ports and leaving stale session state on disk.
  runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  killAllPty()
  void closeAllWatchers()
  if (runtimeRpc) {
    void runtimeRpc.stop().catch((error) => {
      console.error('[runtime] Failed to stop local RPC transport:', error)
    })
  }
  store?.flush()

  // Why: disconnectDaemon writes final checkpoints via async getSnapshot RPCs.
  // Without preventDefault, Electron exits before the RPCs complete and the
  // checkpoint data is lost. The guard prevents an infinite quit loop —
  // app.quit() re-fires will-quit, but the second pass skips straight through.
  if (!daemonDisconnectDone) {
    e.preventDefault()
    disconnectDaemon().finally(() => {
      daemonDisconnectDone = true
      app.quit()
    })
  }
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
