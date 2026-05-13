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
import { initDaemonPtyProvider, disconnectDaemon } from './daemon/daemon-init'
import { closeAllWatchers } from './ipc/filesystem-watcher'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { registerMobileHandlers } from './ipc/mobile'
import { initTelemetry, shutdownTelemetry, trackAppOpenedOnce } from './telemetry/client'
import { runManagedHookInstallers } from './agent-hooks/install-telemetry'
import { initCohortClassifier } from './telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from './telemetry/onboarding-cohort-classifier'
import { resolveConsent } from './telemetry/consent'
import { triggerStartupNotificationRegistration } from './ipc/notifications'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { clearRuntimeMetadataIfOwned } from './runtime/runtime-metadata'
import { registerAppMenu, rebuildAppMenu } from './menu/register-app-menu'
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
import { acquireSingleInstanceLock } from './startup/single-instance-lock'
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
import { getPtyIdForPaneKey, registerPaneKeyTeardownListener, getLocalPtyProvider } from './ipc/pty'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { browserManager } from './browser/browser-manager'
import { setUnreadDockBadgeCount } from './dock/unread-badge'

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

function focusExistingWindow(): void {
  // Why: the second-instance event fires on the *primary* Electron process
  // after another launch tries (and fails) to acquire the lock. Bring the
  // existing window forward so the user sees the same focus behaviour as
  // re-clicking the dock/taskbar icon, rather than a silent no-op.
  //
  // Why show() as well as restore() + focus(): isMinimized() only covers the
  // dock-minimised case. A hidden window (close-to-tray on macOS via Cmd+W,
  // or a window on a different macOS Space) is NOT minimised, so focus()
  // alone is a silent no-op. show() handles those plus Windows taskbar
  // focus-steal, which focus() alone does not reliably trigger.
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.focus()
  }
  // Pre-window case: the primary is still booting and will call
  // openMainWindow() from whenReady(). No action needed here.
}

// Why: the lock must be acquired AFTER configureDevUserDataPath — Electron
// derives the lock identity from the `userData` path, so this placement lets
// dev (`orca-dev`) and packaged (`orca`) runs lock in separate namespaces
// instead of serialising against each other.
//
// Why skip in dev: engineers routinely run `pnpm dev` in parallel from
// multiple worktrees while shipping features, and the lock makes the second
// `pnpm dev` exit silently. In dev we accept that `orca-runtime.json` and
// `endpoint.env` may race (the bundled `orca-dev` CLI / agent hooks route
// to whichever instance wrote last). The dev build is not used for real
// agent work, so that routing ambiguity is acceptable. Packaged Orca keeps
// the lock to protect against the corruption documented in PR #1326 /
// issue #1312.
const hasSingleInstanceLock = is.dev ? true : acquireSingleInstanceLock(app, focusExistingWindow)
if (!hasSingleInstanceLock) {
  if (is.dev) {
    // Why: packaged runs have no attached console, but dev runs do. Emit a
    // single line so a `pnpm dev` operator does not mistake a silent exit
    // for a broken launcher.
    console.log(
      '[single-instance] Another Orca instance is already running against this userData path — focusing existing window.'
    )
  }
  app.quit()
}

// Why: when the lock is held by another process, we've already called
// app.quit() above. Skip every remaining file-writing side effect so this
// transient process never touches userData, and let handler registration
// below happen — those handlers only fire after whenReady, which app.quit()
// prevents from ever dispatching.
if (hasSingleInstanceLock) {
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
}

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

  // Why: telemetry-plan.md§First-launch experience anchors default-on
  // `app_opened` to the first main-window load. Existing users in the
  // pending-banner cohort resolve through telemetry/client.ts; this load
  // path only fires once consent is already enabled.
  const onFirstWindowLoad = (): void => {
    if (!store) {
      return
    }
    const consent = resolveConsent(store.getSettings())
    if (consent.effective !== 'enabled') {
      return
    }
    trackAppOpenedOnce()
  }
  window.webContents.on('did-finish-load', onFirstWindowLoad)

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
    // Why: any running synthesized-title spinner intervals would fire into a
    // destroyed webContents; stop them all here instead of deferring to
    // per-pane teardown, which may never run for restored-but-never-torn-down
    // panes when the window goes away. stopSyntheticTitleSpinner deletes only
    // the current entry, which the Map iterator handles safely.
    for (const paneKey of syntheticTitleSpinnerByPaneKey.keys()) {
      stopSyntheticTitleSpinner(paneKey)
    }
  })
  mainWindow = window
  agentHookServer.setListener(
    ({ paneKey, tabId, worktreeId, connectionId, payload, receivedAt, stateStartedAt }) => {
      if (mainWindow?.isDestroyed()) {
        return
      }
      mainWindow?.webContents.send('agentStatus:set', {
        ...payload,
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        receivedAt,
        stateStartedAt
      })
      // Why: cursor-agent's OSC title stays "Cursor Agent" for the whole turn,
      // and opencode's stays bare "OpenCode" — neither carries a working/idle
      // signal the title heuristic can read. Synthesize an OSC title update
      // from the hook state and inject it into the pane's data stream so the
      // existing renderer-side title tracker (which drives the sidebar
      // spinner, unread badge, and worktree status dot for every other agent)
      // lights up for these panes too. Braille prefix → working keyword path;
      // "action required" → permission; bare label → idle.
      const profile = SYNTHETIC_TITLE_PROFILES[payload.agentType ?? '']
      if (profile) {
        driveSyntheticTitleFromHook(paneKey, payload.state, profile)
      }
    }
  )
  return window
}

// Why: Pi-style persistent spinner — cursor-agent re-emits its own
// "Cursor Agent" OSC title on every internal redraw, so a single synthesized
// "⠋ Cursor Agent" frame gets silently overwritten in the renderer within
// milliseconds and the sidebar dot snaps back to solid. Keep asserting a
// fresh working frame on an interval until the hook reports a non-working
// state. Interval matches Pi's 80ms cadence — fast enough for a smooth
// spinner, slow enough to stay well under the per-flush IPC budget.
// Why: opencode emits a single literal "OpenCode" title at startup and
// nothing thereafter, so a one-shot working frame would suffice for it. We
// reuse the same persistent-spinner mechanism rather than branching because
// the animated spinner is also nicer UX (matches every other working agent).
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

// Why: per-agent labels for the synthesized titles. The detector classifies
// these labels via `containsAgentName` + spinner/keyword rules, so the chosen
// strings must round-trip through detectAgentStatusFromTitle to the right
// status. See agent-status.test.ts for the pinned classifications.
type SyntheticTitleProfile = {
  workingLabel: string
  permissionLabel: string
  idleLabel: string
}
const SYNTHETIC_TITLE_PROFILES: Record<string, SyntheticTitleProfile> = {
  cursor: {
    workingLabel: 'Cursor Agent',
    permissionLabel: 'Cursor - action required',
    idleLabel: 'Cursor ready'
  },
  opencode: {
    workingLabel: 'OpenCode',
    permissionLabel: 'OpenCode - action required',
    idleLabel: 'OpenCode ready'
  }
}

const syntheticTitleSpinnerByPaneKey = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; frame: number; profile: SyntheticTitleProfile }
>()

// Why: on PTY teardown the paneKey→ptyId mapping is dropped, so the spinner
// interval would keep firing but sendSyntheticTitle would no-op forever.
// Stop the interval explicitly so the process doesn't carry a timer per dead
// pane.
registerPaneKeyTeardownListener((paneKey) => {
  stopSyntheticTitleSpinner(paneKey)
})

function sendSyntheticTitle(ptyId: string, data: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('pty:data', { id: ptyId, data })
}

function stopSyntheticTitleSpinner(paneKey: string): void {
  const entry = syntheticTitleSpinnerByPaneKey.get(paneKey)
  if (entry) {
    clearInterval(entry.timer)
    syntheticTitleSpinnerByPaneKey.delete(paneKey)
  }
}

function driveSyntheticTitleFromHook(
  paneKey: string,
  state: string,
  profile: SyntheticTitleProfile
): void {
  const ptyId = getPtyIdForPaneKey(paneKey)
  if (!ptyId) {
    return
  }
  if (state === 'working') {
    // Why: immediately emit the first frame so the spinner starts visible at
    // this hook event even if the interval's next tick is 80ms away. Subsequent
    // frames come from the interval below.
    const existing = syntheticTitleSpinnerByPaneKey.get(paneKey)
    const frame = existing ? existing.frame : 0
    sendSyntheticTitle(ptyId, `\x1b]0;${SPINNER_FRAMES[frame]} ${profile.workingLabel}\x07`)
    if (existing) {
      // Why: refresh the profile so an agent-type change mid-pane (rare, but
      // possible if a hook reports a different agentType than the previous
      // event) lands on the right idle/permission labels at terminal state.
      existing.profile = profile
      return
    }
    const timer = setInterval(() => {
      const ptyIdNow = getPtyIdForPaneKey(paneKey)
      if (!ptyIdNow) {
        stopSyntheticTitleSpinner(paneKey)
        return
      }
      const cur = syntheticTitleSpinnerByPaneKey.get(paneKey)
      if (!cur) {
        return
      }
      cur.frame = (cur.frame + 1) % SPINNER_FRAMES.length
      sendSyntheticTitle(
        ptyIdNow,
        `\x1b]0;${SPINNER_FRAMES[cur.frame]} ${cur.profile.workingLabel}\x07`
      )
    }, SPINNER_INTERVAL_MS)
    syntheticTitleSpinnerByPaneKey.set(paneKey, { timer, frame, profile })
    return
  }
  // Why: leaving the spinner running after a `blocked`/`waiting`/`done` event
  // would immediately race the terminal state back to "working" on the next
  // tick. Stop first, then inject the terminal frame. Idle/done uses a
  // decorated "<Agent> ready" label rather than the bare native title — which
  // for cursor the detector deliberately treats as a no-op so cursor's own
  // per-turn re-emissions cannot clobber our synthesized state. The
  // done/permission frames also carry a trailing BEL (0x07 outside of any OSC
  // sequence) so the tab-level unread badge + notification dispatch in
  // pty-connection lights up — those key off BEL, not the working→idle title
  // transition.
  stopSyntheticTitleSpinner(paneKey)
  const label =
    state === 'blocked' || state === 'waiting' ? profile.permissionLabel : profile.idleLabel
  sendSyntheticTitle(ptyId, `\x1b]0;${label}\x07\x07`)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.stablyai.orca')
  app.setName('Orca')

  if (process.platform === 'darwin' && is.dev) {
    const dockIcon = nativeImage.createFromPath(devIcon)
    app.dock?.setIcon(dockIcon)
  }

  store = new Store()
  // Why: telemetry must initialize before any IPC handler / renderer can
  // call `track()`. The client is a no-op in dev/contributor builds
  // (`IS_OFFICIAL_BUILD === false`) and a no-op while `TELEMETRY_ENABLED`
  // is false in PR 2 — so this call is safe to run early; it only records
  // the Store reference, seeds common props, and resets per-session burst
  // caps. Actual transport initialization is still gated by both flags.
  initTelemetry(store)
  // Why: cohort-classifier reads the repo count synchronously at every emit
  // for cohort-extended events. The Store has been sync-loaded above, and
  // this init runs before any IPC handler is registered and before any
  // window loads — so the classifier is hydrated before any `track()` call,
  // regardless of whether it originates from the renderer, an IPC handler,
  // or `trackAppOpenedOnce` / `did-finish-load`.
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
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
  rateLimits.setSettingsResolver(() => store!.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store!.getSettings()
    return settings.claudeManagedAccounts
      .filter((account) => account.id !== settings.activeClaudeManagedAccountId)
      .map((account) => ({ id: account.id, managedAuthPath: account.managedAuthPath }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store!.getSettings()
    return settings.codexManagedAccounts
      .filter((account) => account.id !== settings.activeCodexManagedAccountId)
      .map((account) => ({ id: account.id, managedHomePath: account.managedHomePath }))
  })
  runtime = new OrcaRuntimeService(store, stats, {
    // Why: resolve the PTY provider lazily. initDaemonPtyProvider() runs later
    // inside attachMainWindowServices and calls setLocalPtyProvider(routedAdapter)
    // to swap the in-process provider for the daemon-routed one. Capturing the
    // provider reference eagerly here would freeze the pre-daemon LocalPtyProvider
    // and defeat the teardown helper's prefix sweep (design §4.3 wire-up).
    getLocalProvider: () => getLocalPtyProvider()
  })
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  starNag = new StarNagService(store, stats)
  starNag.start()
  starNag.registerIpcHandlers()
  runtime.setAgentBrowserBridge(new AgentBrowserBridge(browserManager))
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why: managed hook installation mutates user-global agent config. Each
  // installer runs inside its own try/catch so a malformed local config
  // (e.g. corrupted ~/.claude/settings.json) cannot brick Orca startup.
  // The agent label travels with each installer so the catch can attribute
  // the failure in the `agent_hook_install_failed` telemetry event.
  runManagedHookInstallers([
    ['claude', () => claudeHookService.install()],
    ['codex', () => codexHookService.install()],
    ['gemini', () => geminiHookService.install()],
    ['cursor', () => cursorHookService.install()]
  ])

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
    onToggleLeftSidebar: () => {
      mainWindow?.webContents.send('ui:toggleLeftSidebar')
    },
    onToggleRightSidebar: () => {
      mainWindow?.webContents.send('ui:toggleRightSidebar')
    },
    onToggleAppearance: (key) => {
      if (!store) {
        return
      }
      if (key === 'statusBarVisible') {
        // Why: status bar visibility lives under the persisted UI state
        // (ui:set/ui:get), not settings. The renderer owns the authoritative
        // toggle logic (it knows the current value and persists it back), so
        // we forward the event and let it flip + store.
        mainWindow?.webContents.send('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      store.updateSettings({ [key]: !current[key] })
      // Why: settings:get returns the current snapshot; renderer tracks
      // settings through window.api.settings.get(). Push the new value so
      // the sidebar/titlebar re-render without waiting for a round-trip.
      mainWindow?.webContents.send('settings:changed', { [key]: !current[key] })
      rebuildAppMenu()
    },
    getAppearanceState: () => {
      const settings = store?.getSettings()
      const ui = store?.getUI()
      return {
        showTasksButton: settings?.showTasksButton !== false,
        showTitlebarAppName: settings?.showTitlebarAppName !== false,
        statusBarVisible: ui?.statusBarVisible !== false
      }
    }
  })
  // Why: E2E tests launch parallel Electron instances that would all race to
  // bind the default fixed port, crashing on EADDRINUSE. Port 0 lets the OS
  // assign a random available port per instance while still exercising the
  // full WebSocket startup path.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  // Why: a developer running `pnpm dev` while the packaged Orca is also open
  // would otherwise race the packaged app for 6768 and silently fall back to
  // a random OS-assigned port — breaking deterministic mobile pairing/repro
  // scripts against the dev instance. Pin the first dev instance to 6769 so
  // ws://127.0.0.1:6769 is stable; a second dev instance still falls back via
  // ws-transport's EADDRINUSE handler.
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: app.getPath('userData'),
    enableWebSocket: true,
    ...(isE2E ? { wsPort: 0 } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {})
  })
  registerMobileHandlers(runtimeRpc)

  // Why: the persistent-terminal daemon is always started. If it fails, the
  // LocalPtyProvider (initialized at module load in ipc/pty.ts) remains as the
  // implicit fallback — terminals work, just without cross-restart persistence.
  try {
    await initDaemonPtyProvider()
  } catch (error) {
    console.error('[daemon] Failed to start daemon PTY provider, falling back to local:', error)
  }
  // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from the live server state,
  // so the hook server must start before the window opens — otherwise
  // restored terminals race ahead without the env on first launch.
  try {
    await agentHookServer.start({
      env: app.isPackaged ? 'production' : 'development',
      // Why: passing the userData path lets the server write its endpoint
      // file (PORT/TOKEN/ENV/VERSION) to a stable location. Hook scripts
      // source that file at invocation time so they reach the current Orca
      // even when the PTY's env was frozen under a prior instance.
      userDataPath: app.getPath('userData')
    })
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
    // Why: store can be null if init failed earlier; bail rather than risk a
    // throw inside an Electron event listener.
    if (!store) {
      return
    }
    const onboarding = store.getOnboarding()
    if (onboarding.closedAt !== null) {
      triggerStartupNotificationRegistration(store)
    }
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
  setUnreadDockBadgeCount(0)
  agentHookServer.stop()
  stats?.flush()
  // Why: agent-browser daemon processes would otherwise linger after Orca quits,
  // holding ports and leaving stale session state on disk.
  runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  killAllPty()
  void closeAllWatchers()
  store?.flush()

  // Why: disconnectDaemon writes final checkpoints via async getSnapshot RPCs.
  // Without preventDefault, Electron exits before the RPCs complete and the
  // checkpoint data is lost. The guard prevents an infinite quit loop —
  // app.quit() re-fires will-quit, but the second pass skips straight through.
  if (!daemonDisconnectDone) {
    e.preventDefault()
    // Why: capture ownership synchronously (before any await) so the guard
    // still has the right pid/runtimeId to compare against if shutdown
    // partially clears global state. Evaluating these inside .then() would
    // let a later teardown path null them out mid-chain.
    const ownedPid = process.pid
    const ownedRuntimeId = runtime?.getRuntimeId()
    // Why: the construction of rpcStopAndClear AND the allSettled() below must
    // both live inside the `!daemonDisconnectDone` guard. will-quit re-fires
    // after app.quit() below; without this guard, the second pass would
    // re-invoke runtimeRpc.stop() (redundant rmSync on an already-removed
    // socket) and re-run the ownership-guarded clear against a metadata file
    // that may now belong to the auto-updater's replacement process.
    const rpcStopAndClear = runtimeRpc
      ? runtimeRpc
          .stop()
          .then(() => {
            if (ownedRuntimeId) {
              clearRuntimeMetadataIfOwned(app.getPath('userData'), ownedPid, ownedRuntimeId)
            }
          })
          .catch((error) => {
            console.error('[runtime] Failed to stop local RPC transport:', error)
          })
      : Promise.resolve()
    // Why: Promise.allSettled — we need BOTH the daemon disconnect and the
    // RPC stop + owned-metadata clear to complete before Electron exits.
    // Using allSettled (not all) preserves the existing fail-open posture:
    // if disconnectDaemon rejects, we still quit instead of hanging the app.
    //
    // Telemetry shutdown folds in after the daemon/RPC teardown and BEFORE
    // app.quit(): the PostHog client has up to 2s of bounded flush. Errors
    // inside `shutdownTelemetry()` are caught by the client itself — we
    // catch again here defensively so a flush failure cannot cancel the
    // quit chain.
    Promise.allSettled([disconnectDaemon(), rpcStopAndClear])
      .then(() => shutdownTelemetry())
      .catch(() => {
        /* swallow — telemetry must never prevent app.quit() */
      })
      .then(() => {
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
