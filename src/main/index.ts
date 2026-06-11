/* eslint-disable max-lines -- Why: this is Orca's main-process entry point;
   it owns app lifecycle, service wiring, window creation, and hook/daemon
   startup. Splitting by line count would fragment tightly coupled startup
   logic across files without a cleaner ownership seam. */
import { existsSync } from 'fs'
import { join } from 'path'
import os from 'node:os'
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import * as QRCode from 'qrcode'
import { Store, initDataPath } from './persistence'
import { applyAppIcon } from './app-icon'
import { StatsCollector, initStatsPath } from './stats/collector'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from './opencode-usage/store'
import { killAllPty } from './ipc/pty'
import { initDaemonPtyProvider, disconnectDaemon, shutdownDaemon } from './daemon/daemon-init'
import { closeAllWatchers } from './ipc/filesystem-watcher'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { initObservability, shutdownObservability } from './observability'
import { startSpan } from './observability/tracer'
import { registerMobileHandlers } from './ipc/mobile'
import { initTelemetry, shutdownTelemetry, trackAppOpenedOnce } from './telemetry/client'
import { runManagedHookInstallers } from './agent-hooks/install-telemetry'
import {
  isAgentStatusHooksEnabled,
  MANAGED_AGENT_HOOK_INSTALLERS,
  removeManagedAgentHooks
} from './agent-hooks/managed-agent-hook-controls'
import { initCohortClassifier } from './telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from './telemetry/onboarding-cohort-classifier'
import { resolveConsent } from './telemetry/consent'
import { triggerStartupNotificationRegistration } from './ipc/notifications'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { awaitRuntimeFileWatcherUnsubscribes } from './runtime/orca-runtime-files'
import { clearRuntimeMetadataIfOwned } from './runtime/runtime-metadata'
import { ensureMainI18n, setMainUiLanguage } from './i18n/main-i18n'
import {
  getNextDefaultOnAppearanceSettingValue,
  registerAppMenu,
  rebuildAppMenu
} from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from './updater'
import {
  configureElectronNetworkCompatibility,
  configureDevUserDataPath,
  configureOrcaUserDataPathEnv,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentSignalQuit,
  installDevParentWatchdog,
  installUncaughtPipeErrorGuard,
  isDevParentShutdownRequested,
  patchPackagedProcessPath,
  shouldInstallManagedHooks
} from './startup/configure-process'
import {
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './startup/dev-education-suppression'
import { maybeRedirectAppImageCliLaunch } from './startup/appimage-cli-redirect'
import { startFirstWindowStartupServices } from './startup/first-window-startup-services'
import { getDevInstanceIdentity } from './startup/dev-instance-identity'
import { hydrateShellPath, mergePathSegments } from './startup/hydrate-shell-path'
import {
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  shouldBypassSingleInstanceLock
} from './startup/single-instance-lock'
import { startEventLoopStallProbe } from './startup/event-loop-stall-probe'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from './startup/startup-diagnostics'
import { ensureWindowsUserDataAclGrant } from './startup/windows-user-data-acl'
import { RateLimitService } from './rate-limits/service'
import { getInitialClaudeRateLimitTarget } from './rate-limits/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './rate-limits/codex-rate-limit-target'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow, loadMainWindow } from './window/createMainWindow'
import { focusExistingMainWindow } from './window/focus-existing-window'
import { CodexAccountService } from './codex-accounts/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from './claude-accounts/runtime-selection'
import { codexHookService } from './codex/hook-service'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import { StarNagService } from './star-nag/service'
import { agentHookServer } from './agent-hooks/server'
import { maybeAutoRenameBranchOnFirstWork } from './agent-hooks/first-work-branch-rename'
import { getRepoIdFromWorktreeId } from '../shared/worktree-id'
import { setMigrationUnsupportedPtyListener } from './agent-hooks/migration-unsupported-pty-state'
import {
  clearProviderPtyState,
  getPtyIdForPaneKey,
  registerPaneKeyTeardownListener,
  getLocalPtyProvider,
  registerHeadlessPtyRuntime
} from './ipc/pty'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { EmulatorBridge } from './emulator/emulator-bridge'
import { serveSimStateWatcher } from './emulator/serve-sim-state-watcher'
import { browserManager } from './browser/browser-manager'
import { initializeBrowserSessionsForApp } from './browser/browser-session-startup'
import { setUnreadDockBadgeCount } from './dock/unread-badge'
import { AutomationService } from './automations/service'
import { AgentAwakeService } from './agent-awake-service'
import {
  getCrashBreadcrumbSnapshot,
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-reporting/crash-breadcrumb-store'
import { CrashReportStore } from './crash-reporting/crash-report-store'
import {
  shouldRecordProcessGoneCrash,
  shouldRecoverRendererAfterProcessGone,
  type ExpectedTeardownScope
} from './crash-reporting/process-gone-classification'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData
} from './crash-reporting/process-gone-diagnostics'
import { getProcessGoneDedupeKey, processGoneDedupe } from './crash-reporting/process-gone-dedupe'
import {
  advanceSyntheticTitleSpinnerEntries,
  type SyntheticTitleSpinnerEntry
} from './synthetic-title-spinner'
import { shouldSendSyntheticTitleFrame } from './synthetic-title-visibility'
import { isCrashReportReason } from '../shared/crash-reporting'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  type SyntheticAgentTitleProfile
} from '../shared/synthetic-agent-title'
import type { AgentStatusState } from '../shared/agent-status-types'
import { KeybindingService } from './keybindings/keybinding-service'
import { applyElectronProxySettings } from './network/proxy-settings'

let mainWindow: BrowserWindow | null = null
/** Whether a manual app.quit() (Cmd+Q, etc.) is in progress. Shared with the
 *  window close handler so it can tell the renderer to skip the running-process
 *  confirmation dialog and proceed directly to buffer capture + close. */
let isQuitting = false
let store: Store | null = null
let stats: StatsCollector | null = null
let claudeUsage: ClaudeUsageStore | null = null
let codexUsage: CodexUsageStore | null = null
let openCodeUsage: OpenCodeUsageStore | null = null
let codexAccounts: CodexAccountService | null = null
let codexRuntimeHome: CodexRuntimeHomeService | null = null
let claudeAccounts: ClaudeAccountService | null = null
let claudeRuntimeAuth: ClaudeRuntimeAuthService | null = null
let runtime: OrcaRuntimeService | null = null
let rateLimits: RateLimitService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null
let starNag: StarNagService | null = null
let agentAwakeService: AgentAwakeService | null = null
let crashReports: CrashReportStore | null = null
let unsubscribeAgentAwakeStatusChanges: (() => void) | null = null
let watcherShutdownPromise: Promise<void> | null = null
let watcherShutdownDone = false
let automations: AutomationService | null = null
let keybindings: KeybindingService | null = null
let expectedRendererReload: { webContentsId: number; until: number } | null = null
let firstWindowStartupServicesReady: Promise<void> = Promise.resolve()
let localPtyStartupReady: Promise<void> = Promise.resolve()
const AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS = 30_000
const isServeMode = process.argv.includes('--serve')
const appImageCliRedirect = maybeRedirectAppImageCliLaunch({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath
})
if (appImageCliRedirect.redirected) {
  app.exit(appImageCliRedirect.status)
}

// Why: the store/runtime singletons live here in index.ts; injecting them keeps
// the rename orchestrator free of module-level state and unit-testable.
function maybeAutoRenameBranchOnFirstWorkFromHook(event: {
  paneKey: string
  tabId: string | undefined
  worktreeId: string | undefined
  payload: { state: string; prompt?: string; lastAssistantMessage?: string }
  isReplay: boolean | undefined
}): void {
  const currentStore = store
  const currentRuntime = runtime
  if (!currentStore || !currentRuntime) {
    return
  }
  void maybeAutoRenameBranchOnFirstWork(
    {
      paneKey: event.paneKey,
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      state: event.payload.state,
      prompt: event.payload.prompt,
      assistantMessage: event.payload.lastAssistantMessage,
      isReplay: event.isReplay
    },
    {
      getSettings: () => currentStore.getSettings(),
      getRepo: (repoId) => currentStore.getRepo(repoId),
      getAgentEnvResolvers: () => currentRuntime.getCommitMessageAgentEnvironmentResolvers(),
      getCurrentDisplayName: (worktreeId) => currentStore.getWorktreeMeta(worktreeId)?.displayName,
      canRenameOrcaCreatedBranch: (worktreeId) => {
        const meta = currentStore.getWorktreeMeta(worktreeId)
        // Why: a user/imported branch can coincidentally be named after a creature.
        // Only worktrees Orca stamped at creation are safe to auto-rename.
        return !!meta?.orcaCreationSource && meta.preserveBranchOnDelete !== true
      },
      setDisplayName: (worktreeId, displayName) => {
        currentStore.setWorktreeMeta(worktreeId, {
          displayName,
          pendingFirstAgentMessageRename: false,
          // Success always clears the failure badge, even if the explicit
          // setRenameError(null) clear is redundant.
          firstAgentMessageRenameError: null
        })
      },
      setRenameError: (worktreeId, error) => {
        // Skip the write + renderer push when nothing changes — benign skips
        // clear the error on every settled worktree, most of which never had one.
        const current = currentStore.getWorktreeMeta(worktreeId)?.firstAgentMessageRenameError
        if ((current ?? null) === (error ?? null)) {
          return
        }
        currentStore.setWorktreeMeta(worktreeId, { firstAgentMessageRenameError: error })
        // Push to the renderer so the badge updates — the hook only knows the
        // worktreeId, so derive the repoId the same way notifyBranchRenamed expects.
        currentRuntime.notifyBranchRenamed(getRepoIdFromWorktreeId(worktreeId))
      },
      resolveWorktreeIdForTab: (tabId) => currentStore.getWorktreeIdForTab(tabId),
      onRenamed: (repoId) => currentRuntime.notifyBranchRenamed(repoId)
    }
  )
}

const devInstanceIdentity = getDevInstanceIdentity(is.dev)
const devAgentHookEndpointNamespace = devInstanceIdentity.isDev
  ? devInstanceIdentity.appUserModelId
  : undefined

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
configureOrcaUserDataPathEnv()
const startupDiagnosticsEnabled = isStartupDiagnosticsEnabled()
if (startupDiagnosticsEnabled) {
  logStartupDiagnostic('before-single-instance-lock', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    osRelease: os.release(),
    userData: app.getPath('userData'),
    e2eUserData: Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  })
  startEventLoopStallProbe()
}

// Why: startup benchmarking needs in-process timestamps — harness-side stderr
// arrival times include pipe buffering jitter. `t` is ms since process start.
function logStartupMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (startupDiagnosticsEnabled) {
    logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
  }
}

function focusExistingWindow(): void {
  focusExistingMainWindow({
    app,
    getWindow: () => mainWindow,
    openWindow: openMainWindow,
    warn: console.warn
  })
}

function markExpectedRendererReload(webContentsId: number, durationMs = 10_000): void {
  expectedRendererReload = { webContentsId, until: Date.now() + durationMs }
}

function clearExpectedRendererReload(webContentsId?: number): void {
  if (webContentsId === undefined || expectedRendererReload?.webContentsId === webContentsId) {
    expectedRendererReload = null
  }
}

function getExpectedTeardownScope(webContentsId?: number): ExpectedTeardownScope {
  if (isQuitting || isQuittingForUpdate()) {
    return 'app-shutdown'
  }
  if (!expectedRendererReload) {
    return 'none'
  }
  if (Date.now() > expectedRendererReload.until) {
    expectedRendererReload = null
    return 'none'
  }
  return webContentsId !== undefined && expectedRendererReload.webContentsId === webContentsId
    ? 'renderer-reload'
    : 'none'
}

function recordAgentStateCrashBreadcrumb(agentType: string, state: string): void {
  // Why: hook pings can arrive many times per second while an agent works.
  // Coalescing preserves crash-report room for renderer errors and memory
  // samples instead of filling all 30 breadcrumbs with identical state pings.
  recordCoalescedCrashBreadcrumb({
    name: 'agent_state_changed',
    data: { agentType, state },
    coalesceKey: `agent:${agentType}:${state}`,
    minIntervalMs: AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS
  })
}

// Why: the lock must be acquired AFTER configureDevUserDataPath — Electron
// derives the lock identity from the `userData` path, so this placement lets
// dev (`orca-dev`) and packaged (`orca`) runs lock in separate namespaces
// instead of serialising against each other.
//
// Why skip in dev: engineers routinely run `pnpm dev` in parallel from
// multiple worktrees while shipping features, and the lock makes the second
// `pnpm dev` exit silently. In dev we accept that `orca-runtime.json` may race
// (the bundled `orca-dev` CLI routes to whichever instance wrote last). Agent
// hook endpoint files are namespaced per dev instance when the hook server
// starts below. Packaged Orca keeps the lock to protect against the corruption
// documented in PR #1326 / issue #1312.
const bypassSingleInstanceLock = shouldBypassSingleInstanceLock({
  isDev: is.dev,
  isServeMode
})
if (bypassSingleInstanceLock) {
  // Why: this is an explicit diagnostic escape hatch for macOS builds where
  // Electron reports a false lock loss before any normal app logs exist.
  logSingleInstanceLockBypass()
}
const hasSingleInstanceLock =
  is.dev && !isServeMode
    ? true
    : bypassSingleInstanceLock
      ? true
      : acquireSingleInstanceLock(app, focusExistingWindow)
if (startupDiagnosticsEnabled) {
  logStartupDiagnostic('single-instance-lock-result', {
    acquired: hasSingleInstanceLock,
    bypassed: bypassSingleInstanceLock,
    skippedForDev: is.dev && !isServeMode
  })
}
if (!hasSingleInstanceLock) {
  // Why: if Electron returns a false negative here, packaged macOS launches
  // otherwise look like silent crashes. `open --stderr` can capture this line.
  logSingleInstanceLockFailure()
  app.quit()
}

// Why: when the lock is held by another process, we've already called
// app.quit() above. Skip every remaining file-writing side effect so this
// transient process never touches userData, and let handler registration
// below happen — those handlers only fire after whenReady, which app.quit()
// prevents from ever dispatching.
if (hasSingleInstanceLock) {
  // Why: dev parent shutdown coupling is only for electron-vite desktop runs.
  // `orca serve` may be launched through a CLI shim or background shell whose
  // parent lifetime is not the intended server lifetime.
  const shouldCoupleToDevParent = is.dev && !isServeMode
  installDevParentDisconnectQuit(shouldCoupleToDevParent)
  installDevParentWatchdog(shouldCoupleToDevParent)
  installDevParentSignalQuit(shouldCoupleToDevParent)
  // Why: must run after configureDevUserDataPath (which redirects userData to
  // orca-dev in dev mode) but before app.setName('Orca') inside whenReady
  // (which would change the resolved path on case-sensitive filesystems).
  initDataPath()
  // Why: same timing constraint as initDataPath — capture the userData path
  // before app.setName changes it. See persistence.ts:20-28.
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  crashReports = CrashReportStore.fromUserData()
  recordCrashBreadcrumb('app_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  configureElectronNetworkCompatibility()
  enableMainProcessGpuFeatures()
}

ipcMain.handle('app:awaitFirstWindowStartupServices', async () => {
  await firstWindowStartupServicesReady
})

function startDesktopFirstWindowStartupServices(): Promise<void> {
  const startupServices = startFirstWindowStartupServices({
    // Why: the persistent-terminal daemon is desktop-only. Headless `orca serve`
    // registers its PTY runtime separately and must not spawn the desktop daemon
    // or hook loopback listener.
    startDaemonPtyProvider: (signal) => initDaemonPtyProvider(signal),
    // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from the live server state, so
    // the renderer awaits this barrier before restored terminals reconnect.
    startAgentHookServer: () =>
      agentHookServer.start({
        env: app.isPackaged ? 'production' : 'development',
        // Why: hooks source this endpoint file at invocation time, so old PTY
        // env still reaches the current Orca process after an app restart.
        // Dev uses a namespace because all worktrees share `orca-dev`.
        userDataPath: app.getPath('userData'),
        endpointNamespace: devAgentHookEndpointNamespace
      }),
    onDaemonError: (error) => {
      console.error('[daemon] Failed to start daemon PTY provider, falling back to local:', error)
    },
    onAgentHookServerError: (error) => {
      // Why: Claude/Codex/Gemini/OpenCode/Cursor hook callbacks are sidebar
      // enrichment only. Orca must still boot if the loopback receiver fails.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })
  firstWindowStartupServicesReady = startupServices.firstWindowReady
  localPtyStartupReady = startupServices.localPtyReady
  return firstWindowStartupServicesReady
}

function prepareCodexRuntimeHomeForLaunch(target?: CodexAccountSelectionTarget): string | null {
  const runtimeHomePath = codexRuntimeHome!.prepareForCodexLaunch(target)
  const hooksEnabled = isAgentStatusHooksEnabled(store?.getSettings())
  try {
    // Why: launch prep is reachable after startup via PTY/runtime paths; honor
    // the persisted off switch so those launches cannot reinstall removed hooks.
    const status = hooksEnabled
      ? codexHookService.install()
      : codexHookService.refreshRuntimeUserHooks()
    if (status.state === 'error') {
      console.warn(
        `[codex-hook-service] failed to ${
          hooksEnabled ? 'refresh' : 'refresh user'
        } runtime hooks before launch`,
        status.detail
      )
    }
  } catch (error) {
    // Why: hook install/removal is best-effort launch prep. A malformed hooks file
    // should not block the Codex process from starting with its prepared auth.
    console.warn(
      `[codex-hook-service] failed to ${
        hooksEnabled ? 'refresh' : 'refresh user'
      } runtime hooks before launch`,
      error
    )
  }
  return runtimeHomePath
}

function openMainWindow(): BrowserWindow {
  logStartupMilestone('open-main-window-start')
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
  if (!openCodeUsage) {
    throw new Error('OpenCode usage store must be initialized before opening the main window')
  }
  if (!rateLimits) {
    throw new Error('Rate limit service must be initialized before opening the main window')
  }
  if (!automations) {
    throw new Error('Automation service must be initialized before opening the main window')
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
  if (!keybindings) {
    throw new Error('Keybinding service must be initialized before opening the main window')
  }

  // Why: Chromium's BrowserWindow constructor resets the userData DACL to a
  // Protected DACL, breaking writes in pre-existing subdirs. Explicit ACEs on
  // userData + immediate children fix the tree permanently; the grant runs in
  // the background on first launch only (marker-gated) because the previous
  // synchronous recursive walk blocked startup ~60s on large profiles. See
  // startup/windows-user-data-acl.ts; per-write EPERM retries are the backstop.
  if (process.platform === 'win32') {
    logStartupMilestone('acl-grant-start')
    ensureWindowsUserDataAclGrant(app.getPath('userData'), {
      onDone: (result) => {
        logStartupMilestone('acl-grant-done', { mode: result.mode })
        if (result.mode === 'failed') {
          console.warn('[win32-acl] userData ACL grant failed:', result.reason)
        }
      }
    })
  }

  const window = createMainWindow(store, {
    getIsQuitting: () => isQuitting,
    onQuitAborted: () => {
      isQuitting = false
      clearExpectedRendererReload()
    },
    onRendererProcessGone: (details, webContentsId) => {
      recordProcessGoneCrash(
        'renderer',
        'renderer',
        details.reason,
        details.exitCode ?? null,
        {
          processType: 'renderer'
        },
        webContentsId
      )
    },
    shouldRecordRendererCrash: (details, webContentsId) =>
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode ?? null,
        expectedTeardown: getExpectedTeardownScope(webContentsId)
      }),
    shouldRecoverRenderer: (details, webContentsId) =>
      shouldRecoverRendererAfterProcessGone({
        reason: details.reason,
        expectedTeardown: getExpectedTeardownScope(webContentsId)
      }),
    deferLoad: true,
    title: devInstanceIdentity.name,
    getKeybindings: () => keybindings?.getOverrides(),
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (mainWindow?.webContents.id === webContentsId) {
        markExpectedRendererReload(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    }
  })
  recordCrashBreadcrumb('main_window_created')
  logStartupMilestone('window-created')
  window.once('ready-to-show', () => {
    logStartupMilestone('ready-to-show')
  })

  // Why: telemetry-plan.md§First-launch experience anchors default-on
  // `app_opened` to the first main-window load. Existing users in the
  // pending-banner cohort resolve through telemetry/client.ts; this load
  // path only fires once consent is already enabled.
  const rendererWebContentsId = window.webContents.id
  const onFirstWindowLoad = (): void => {
    clearExpectedRendererReload(rendererWebContentsId)
    recordCrashBreadcrumb('main_window_loaded')
    logStartupMilestone('did-finish-load')
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
    openCodeUsage,
    codexAccounts,
    claudeAccounts,
    rateLimits,
    rendererWebContentsId,
    automations,
    {
      prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
      prepareForClaudeLaunch: () => claudeRuntimeAuth!.prepareForClaudeLaunch()
    },
    agentAwakeService ?? undefined,
    crashReports ?? undefined,
    keybindings,
    {
      onBeforeRelaunch: () => {
        isQuitting = true
        store?.flush()
      }
    }
  )
  automations.setWebContents(window.webContents)
  automations.start()
  attachMainWindowServices(
    window,
    store,
    runtime,
    prepareCodexRuntimeHomeForLaunch,
    (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    {
      awaitLocalPtyStartup: () => localPtyStartupReady,
      onBeforeRendererReload: ({ ignoreCache, webContentsId }) => {
        if (window.webContents.id === webContentsId) {
          markExpectedRendererReload(webContentsId)
        }
        recordCrashBreadcrumb('renderer_reload_requested', { ignoreCache })
      }
    }
  )
  rateLimits.attach(window)
  // Why: quota probes can spawn CLIs and hit network. The attached show/focus
  // listeners refresh as soon as the window can present quota UI, so do not
  // compete with first paint.
  rateLimits.start({ fetchImmediately: false })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
    clearExpectedRendererReload(rendererWebContentsId)
    automations?.setWebContents(null)
    // Why: detach the agent hook listener on window close so the server
    // never fires into a destroyed webContents during the gap before
    // reopen (e.g. macOS dock re-activation). This also ensures the
    // replay-loop through lastStatusByPaneKey runs only on deliberate
    // window recreations instead of stacking on top of stale listeners.
    agentHookServer.setListener(null)
    agentHookServer.setPaneStatusClearListener(null)
    setMigrationUnsupportedPtyListener(null)
    // Why: any running synthesized-title spinner timer would fire into a
    // destroyed webContents; stop it here instead of deferring to per-pane
    // teardown, which may never run for restored-but-never-torn-down panes
    // when the window goes away.
    stopAllSyntheticTitleSpinners()
  })
  mainWindow = window
  window.on('show', resumeSyntheticTitleSpinnerTimer)
  window.on('restore', resumeSyntheticTitleSpinnerTimer)
  window.on('hide', stopSyntheticTitleSpinnerTimer)
  window.on('minimize', stopSyntheticTitleSpinnerTimer)
  agentHookServer.setListener(
    ({
      paneKey,
      tabId,
      worktreeId,
      connectionId,
      payload,
      receivedAt,
      stateStartedAt,
      providerSession,
      isReplay
    }) => {
      if (mainWindow?.isDestroyed()) {
        return
      }
      maybeAutoRenameBranchOnFirstWorkFromHook({ paneKey, tabId, worktreeId, payload, isReplay })
      const orchestration = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)
      const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
      mainWindow?.webContents.send('agentStatus:set', {
        ...payload,
        paneKey,
        ...(terminalHandle ? { terminalHandle } : {}),
        tabId,
        worktreeId,
        connectionId,
        receivedAt,
        stateStartedAt,
        ...(providerSession ? { providerSession } : {}),
        ...(orchestration ? { orchestration } : {})
      })
      recordAgentStateCrashBreadcrumb(payload.agentType ?? 'unknown', payload.state)
      // Why: some native OSC titles miss terminal idle/permission frames.
      // Inject hook-derived frames so the renderer title tracker updates too.
      const profile = getSyntheticAgentTitleProfile(payload.agentType)
      if (profile && shouldDriveSyntheticAgentTitleFromHook(payload.agentType, payload.state)) {
        driveSyntheticTitleFromHook(paneKey, payload.state, profile)
      }
    }
  )
  agentHookServer.setPaneStatusClearListener((paneKey) => {
    if (mainWindow?.isDestroyed()) {
      return
    }
    mainWindow?.webContents.send('agentStatus:clear', { paneKey })
  })
  setMigrationUnsupportedPtyListener((event) => {
    if (mainWindow?.isDestroyed()) {
      return
    }
    if (event.type === 'set') {
      mainWindow?.webContents.send('agentStatus:migrationUnsupported', event.entry)
    } else {
      mainWindow?.webContents.send('agentStatus:migrationUnsupportedClear', {
        ptyId: event.ptyId
      })
    }
  })
  logStartupMilestone('load-start')
  loadMainWindow(window)
  return window
}

function sendOpenFeatureTour(targetWindow?: BrowserWindow | null): void {
  const webContents =
    targetWindow && !targetWindow.isDestroyed() ? targetWindow.webContents : mainWindow?.webContents
  webContents?.send('ui:openFeatureTour')
}

function sendOpenSetupGuide(targetWindow?: BrowserWindow | null): void {
  const webContents =
    targetWindow && !targetWindow.isDestroyed() ? targetWindow.webContents : mainWindow?.webContents
  webContents?.send('ui:openSetupGuide')
}

function sendOpenCrashReport(targetWindow?: BrowserWindow | null): void {
  const webContents =
    targetWindow && !targetWindow.isDestroyed() ? targetWindow.webContents : mainWindow?.webContents
  webContents?.send('ui:openCrashReport')
}

function recordProcessGoneCrash(
  source: 'renderer' | 'child',
  processType: string,
  reason: string,
  exitCode: number | null,
  details: Record<string, unknown>,
  webContentsId?: number
): void {
  if (!crashReports || !isCrashReportReason(reason)) {
    return
  }
  if (
    !shouldRecordProcessGoneCrash({
      source,
      processType,
      serviceName: typeof details.serviceName === 'string' ? details.serviceName : undefined,
      reason,
      exitCode,
      expectedTeardown: getExpectedTeardownScope(webContentsId)
    })
  ) {
    recordCrashBreadcrumb(
      'process_gone_suppressed',
      buildSuppressedProcessGoneBreadcrumbData({
        source,
        processType,
        reason,
        exitCode,
        details
      })
    )
    return
  }
  const key = getProcessGoneDedupeKey(processType, reason, exitCode)
  if (!processGoneDedupe.shouldRecord(key)) {
    return
  }
  const crashDetails = buildProcessGoneCrashDetails(details)
  const span = startSpan('electron.process_gone', {
    attributes: {
      'crash.source': source,
      'crash.process_type': processType,
      'crash.reason': reason,
      ...(exitCode !== null ? { 'crash.exit_code': exitCode } : {}),
      'app.version': app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      details: crashDetails,
      breadcrumbs: getCrashBreadcrumbSnapshot()
    }
  })
  // Why: renderer/child crashes belong in the local trace lane so the
  // diagnostic bundle has the same process-gone signal as the startup prompt.
  span.fail(`${source} process gone: ${processType} ${reason} (${exitCode ?? 'unknown'})`)
  void crashReports
    .record({
      source,
      processType,
      reason,
      exitCode,
      appVersion: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      details: crashDetails,
      // Why: breadcrumbs stay memory-only during normal operation. Persist a
      // snapshot only after Electron reports a crash-like process exit.
      breadcrumbs: getCrashBreadcrumbSnapshot()
    })
    .catch((error) => {
      console.error('[crash-reporting] Failed to persist crash report:', error)
    })
}

function shutdownWatchersOnce(): Promise<void> {
  if (watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Why: @parcel/watcher tears down native async work during unsubscribe.
    // Electron must wait for that cleanup before Node's environment exits.
    watcherShutdownPromise = closeAllWatchers()
      .catch((error) => {
        console.error('[filesystem-watcher] shutdown failed:', error)
      })
      .then(() => {
        watcherShutdownDone = true
      })
  }
  return watcherShutdownPromise
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

const syntheticTitleSpinnerByPaneKey = new Map<
  string,
  SyntheticTitleSpinnerEntry<SyntheticAgentTitleProfile>
>()
let syntheticTitleSpinnerTimer: ReturnType<typeof setInterval> | null = null

type ServeOptions = {
  json: boolean
  wsPort?: number
  pairingAddress: string | null
  noPairing: boolean
  mobilePairing: boolean
}

function getServeOptions(argv = process.argv): ServeOptions {
  const valueAfter = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    if (index === -1) {
      return null
    }
    const value = argv[index + 1]
    return value && !value.startsWith('--') ? value : null
  }
  const rawPort = valueAfter('--serve-port')
  let wsPort: number | undefined
  if (rawPort) {
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --serve-port value: ${rawPort}`)
    }
    wsPort = parsedPort
  }
  return {
    json: argv.includes('--serve-json'),
    ...(wsPort !== undefined ? { wsPort } : {}),
    pairingAddress: valueAfter('--serve-pairing-address'),
    noPairing: argv.includes('--serve-no-pairing'),
    mobilePairing: argv.includes('--serve-mobile-pairing')
  }
}

function getBundledWebClientRoot(): string | undefined {
  const root = join(app.getAppPath(), 'out', 'web')
  return existsSync(join(root, 'web-index.html')) ? root : undefined
}

async function renderTerminalPairingQr(pairingUrl: string): Promise<string | null> {
  try {
    return await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
  } catch {
    try {
      return await QRCode.toString(pairingUrl, { type: 'utf8' })
    } catch {
      return null
    }
  }
}

async function printServeReady(options: ServeOptions): Promise<void> {
  if (!runtime || !runtimeRpc) {
    throw new Error('Runtime server must be initialized before printing serve readiness')
  }
  const endpoint = runtimeRpc.getWebSocketEndpoint()
  const pairing = options.noPairing
    ? ({ available: false } as const)
    : runtimeRpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: options.mobilePairing ? 'mobile' : 'runtime'
      })
  const pairingQr =
    pairing.available && options.mobilePairing
      ? await renderTerminalPairingQr(pairing.pairingUrl)
      : null
  if (options.json) {
    console.log(
      JSON.stringify({
        type: 'orca_server_ready',
        runtimeId: runtime.getRuntimeId(),
        endpoint,
        pairing: pairing.available
          ? {
              url: pairing.pairingUrl,
              endpoint: pairing.endpoint,
              deviceId: pairing.deviceId,
              webClientUrl: pairing.webClientUrl,
              scope: options.mobilePairing ? 'mobile' : 'runtime',
              qr: pairingQr
            }
          : null
      })
    )
    return
  }
  console.log(`Orca server ready: ${endpoint ?? 'websocket unavailable'}`)
  if (pairing.available) {
    if (pairing.webClientUrl) {
      console.log(`Web client URL: ${pairing.webClientUrl}`)
    }
    if (options.mobilePairing && pairingQr) {
      console.log(`Mobile pairing QR:\n${pairingQr}`)
    }
    console.log(`Pairing URL: ${pairing.pairingUrl}`)
  }
}

function installServeSignalHandlers(): void {
  const quit = (): void => {
    // Why: foreground `orca serve` is controlled by the parent CLI/terminal,
    // so POSIX termination signals should follow Electron's normal quit path
    // and flush runtime metadata, daemon checkpoints, and telemetry.
    app.quit()
  }
  process.once('SIGINT', quit)
  process.once('SIGTERM', quit)
}

// Why: on PTY teardown the paneKey mapping is dropped, so the spinner tick
// would keep firing but sendSyntheticTitle would no-op forever. Drop the
// entry explicitly so the shared timer shuts down once no panes are active.
registerPaneKeyTeardownListener((paneKey) => {
  stopSyntheticTitleSpinner(paneKey)
})

function sendSyntheticTitle(ptyId: string, data: string, options: { force?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  // Why: repeated working-spinner frames are decorative and can arrive every
  // 80ms per agent. Final/permission frames are forced because they drive BEL.
  if (
    !shouldSendSyntheticTitleFrame({
      force: options.force === true,
      windowVisible: isSyntheticTitleWindowVisible()
    })
  ) {
    return
  }
  mainWindow.webContents.send('pty:data', { id: ptyId, data })
}

function isSyntheticTitleWindowVisible(): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized()
  )
}

function canSendDecorativeSyntheticTitle(): boolean {
  return shouldSendSyntheticTitleFrame({
    force: false,
    windowVisible: isSyntheticTitleWindowVisible()
  })
}

function stopSyntheticTitleSpinner(paneKey: string): void {
  if (syntheticTitleSpinnerByPaneKey.delete(paneKey)) {
    stopSyntheticTitleSpinnerTimerIfIdle()
  }
}

function stopAllSyntheticTitleSpinners(): void {
  syntheticTitleSpinnerByPaneKey.clear()
  stopSyntheticTitleSpinnerTimer()
}

function stopSyntheticTitleSpinnerTimer(): void {
  if (!syntheticTitleSpinnerTimer) {
    return
  }
  clearInterval(syntheticTitleSpinnerTimer)
  syntheticTitleSpinnerTimer = null
}

function stopSyntheticTitleSpinnerTimerIfIdle(): void {
  if (syntheticTitleSpinnerByPaneKey.size === 0) {
    stopSyntheticTitleSpinnerTimer()
  }
}

function tickSyntheticTitleSpinners(): void {
  if (!canSendDecorativeSyntheticTitle()) {
    stopSyntheticTitleSpinnerTimer()
    return
  }
  const ticks = advanceSyntheticTitleSpinnerEntries({
    entries: syntheticTitleSpinnerByPaneKey,
    frameCount: SPINNER_FRAMES.length,
    getPtyIdForPaneKey
  })
  for (const tick of ticks) {
    sendSyntheticTitle(
      tick.ptyId,
      `\x1b]0;${SPINNER_FRAMES[tick.frame]} ${tick.profile.workingLabel}\x07`
    )
  }
  stopSyntheticTitleSpinnerTimerIfIdle()
}

function ensureSyntheticTitleSpinnerTimer(): void {
  if (
    syntheticTitleSpinnerTimer ||
    syntheticTitleSpinnerByPaneKey.size === 0 ||
    !canSendDecorativeSyntheticTitle()
  ) {
    return
  }
  // Why: a single process timer covers all synthesized title spinners; per-pane
  // intervals multiplied idle wakeups when several retained agents were working.
  syntheticTitleSpinnerTimer = setInterval(tickSyntheticTitleSpinners, SPINNER_INTERVAL_MS)
}

function resumeSyntheticTitleSpinnerTimer(): void {
  ensureSyntheticTitleSpinnerTimer()
}

function driveSyntheticTitleFromHook(
  paneKey: string,
  state: AgentStatusState,
  profile: SyntheticAgentTitleProfile
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
    syntheticTitleSpinnerByPaneKey.set(paneKey, { frame, profile })
    ensureSyntheticTitleSpinnerTimer()
    return
  }
  // Why: leaving the spinner running after a `blocked`/`waiting`/`done` event
  // would immediately race the terminal state back to "working" on the next
  // tick. Stop first, then inject the terminal frame. Idle/done uses a
  // decorated "<Agent> ready" label rather than the bare native title — which
  // for cursor the detector deliberately treats as a no-op so cursor's own
  // per-turn re-emissions cannot clobber our synthesized state. The
  // Permission frames also carry a trailing BEL (0x07 outside of any OSC
  // sequence) so user-input-required states light up immediately. Done frames
  // intentionally avoid the extra BEL: hook/status completion notifications
  // own final-task attention and can cancel milestone noise during loops.
  stopSyntheticTitleSpinner(paneKey)
  const needsUserInput = state === 'blocked' || state === 'waiting'
  const label = needsUserInput ? profile.permissionLabel : profile.idleLabel
  sendSyntheticTitle(ptyId, `\x1b]0;${label}\x07${needsUserInput ? '\x07' : ''}`, {
    force: true
  })
}

app.whenReady().then(async () => {
  logStartupMilestone('app-ready')
  electronApp.setAppUserModelId(devInstanceIdentity.appUserModelId)
  app.setName(devInstanceIdentity.name)

  store = new Store()
  logStartupMilestone('store-loaded')
  applyAppIcon(store.getSettings().appIcon)
  if (shouldSuppressDevEducation({ isDev: is.dev })) {
    suppressDevEducationForStore(store)
  }
  try {
    // Why: Dock/Launchpad launches do not inherit shell proxy env vars, so the
    // persisted proxy must be applied before any app-owned network fetchers run.
    await applyElectronProxySettings(store.getSettings())
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings')
  }
  // Why: browser sessions are used by desktop webviews and runtime profile
  // commands, so initialize them at app startup instead of a renderer IPC path.
  initializeBrowserSessionsForApp()
  agentAwakeService = new AgentAwakeService()
  agentAwakeService.setEnabled(store.getSettings().keepComputerAwakeWhileAgentsRun)
  // Why: disk-hydrated status rows are UI continuity only. The service starts
  // from an empty snapshot; only hook events observed in this runtime can keep
  // the local computer awake.
  agentAwakeService.setStatuses([])
  unsubscribeAgentAwakeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    agentAwakeService?.setStatuses(statuses)
  })
  // Why: telemetry must initialize before any IPC handler / renderer can
  // call `track()`. The client is a no-op in dev/contributor builds
  // (`IS_OFFICIAL_BUILD === false`) and a no-op while `TELEMETRY_ENABLED`
  // is false in PR 2 — so this call is safe to run early; it only records
  // the Store reference, seeds common props, and resets per-session burst
  // caps. Actual transport initialization is still gated by both flags.
  initTelemetry(store)
  // Why: the error-tracking lane (telemetry-error-tracking.md) is its own
  // composition root — independent of product telemetry — and must
  // initialize before any IPC handler / runtime span is created so the
  // tracer's active sink is populated at the moment the first span fires.
  // Honors DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / ORCA_DIAGNOSTICS_DISABLED
  // / CI internally; those gates do not need to be re-checked here.
  initObservability()
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
  openCodeUsage = new OpenCodeUsageStore(store)
  rateLimits = new RateLimitService()
  codexRuntimeHome = new CodexRuntimeHomeService(store)
  codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome)
  claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver((target) =>
    codexRuntimeHome!.prepareForRateLimitFetch(target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth!.prepareForRateLimitFetch(target)
  )
  rateLimits.setSettingsResolver(() => store!.getSettings())
  keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store!.getSettings().keybindings
  })
  browserManager.setSettingsResolver(() => ({ keybindings: keybindings?.getOverrides() }))
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store!.getSettings()
    const activeIds = new Set(
      [
        normalizeClaudeRuntimeSelection(settings).host,
        ...Object.values(normalizeClaudeRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthPath: account.managedAuthPath,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store!.getSettings()
    const activeIds = new Set(
      [
        normalizeCodexRuntimeSelection(settings).host,
        ...Object.values(normalizeCodexRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({ id: account.id, managedHomePath: account.managedHomePath }))
  })
  const runtimeService = new OrcaRuntimeService(store, stats, {
    // Why: resolve the PTY provider lazily. initDaemonPtyProvider() runs later
    // inside attachMainWindowServices and calls setLocalPtyProvider(routedAdapter)
    // to swap the in-process provider for the daemon-routed one. Capturing the
    // provider reference eagerly here would freeze the pre-daemon LocalPtyProvider
    // and defeat the teardown helper's prefix sweep (design §4.3 wire-up).
    getLocalProvider: () => getLocalPtyProvider(),
    onPtyStopped: clearProviderPtyState,
    onTerminalAgentStatus: (event) => {
      agentHookServer.ingestTerminalStatus(event)
    }
  })
  runtime = runtimeService
  automations = new AutomationService(store, { claudeUsage, codexUsage })
  runtimeService.setAutomationService(automations)
  runtimeService.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtimeService.setCommitMessageAgentEnvironmentResolvers({
    // Why: local Codex hooks and auth now live in Orca's managed runtime home
    // even for the system-default path, so every Orca-launched Codex process
    // must resolve CODEX_HOME through the runtime-home service.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: () => claudeRuntimeAuth!.prepareForClaudeLaunch()
  })
  starNag = new StarNagService(store, stats)
  starNag.start()
  starNag.registerIpcHandlers()
  runtimeService.setAgentBrowserBridge(
    new AgentBrowserBridge(browserManager, {
      onTabsChanged: (worktreeId) => runtimeService.notifyMobileSessionTabsChanged(worktreeId)
    })
  )

  // Emulator bridge (serve-sim). macOS-only feature (gated in CLI/runtime); always ship like agent-browser.
  const emulatorBridge = new EmulatorBridge()
  runtimeService.setEmulatorBridge(emulatorBridge)
  serveSimStateWatcher.start()
  serveSimStateWatcher.onDetected(({ worktreeId, info }) => {
    runtimeService.getEmulatorBridge()?.registerActiveEmulator(worktreeId, info, {
      managed: false
    })
    serveSimStateWatcher.markOrcaManaged(info)
    runtimeService.notifyEmulatorAutoAttachFromWatcher(worktreeId, info)
  })
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  if (shouldInstallManagedHooks(is.dev)) {
    // Why: the persisted off switch must run before any auto-install path so
    // users who removed Orca-managed hooks do not see them silently reappear on launch.
    if (isAgentStatusHooksEnabled(store.getSettings())) {
      runManagedHookInstallers(MANAGED_AGENT_HOOK_INSTALLERS)
    } else {
      removeManagedAgentHooks()
    }
  }

  app.on('child-process-gone', (_event, details) => {
    recordProcessGoneCrash('child', details.type, details.reason, details.exitCode ?? null, {
      name: details.name,
      serviceName: details.serviceName,
      type: details.type
    })
  })

  logStartupMilestone('services-initialized')
  await ensureMainI18n()
  await setMainUiLanguage(store.getSettings().uiLanguage)
  logStartupMilestone('i18n-ready')

  registerAppMenu({
    onCheckForUpdates: (options) => checkForUpdatesFromMenu(options),
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (mainWindow?.webContents.id === webContentsId) {
        markExpectedRendererReload(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    },
    onOpenSettings: () => {
      recordCrashBreadcrumb('settings_opened')
      mainWindow?.webContents.send('ui:openSettings')
    },
    onOpenSetupGuide: (targetWindow) => {
      recordCrashBreadcrumb('setup_guide_opened')
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenSetupGuide(targetBrowserWindow)
    },
    onOpenCrashReport: (targetWindow) => {
      recordCrashBreadcrumb('crash_report_opened')
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenCrashReport(targetBrowserWindow)
    },
    onOpenFeatureTour: (targetWindow) => {
      recordCrashBreadcrumb('feature_tour_opened')
      // Why: menu clicks provide the BrowserWindow that invoked the item. Use it
      // first so hidden/headless E2E windows and future multi-window flows route
      // the tour to the correct renderer instead of relying on global focus.
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenFeatureTour(targetBrowserWindow)
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
      // Why: these appearance settings are default-on for older profiles, so
      // a missing persisted value must toggle from visible -> hidden.
      const next = getNextDefaultOnAppearanceSettingValue(current[key])
      store.updateSettings({ [key]: next }, { notifyListeners: true })
      rebuildAppMenu()
    },
    getAppearanceState: () => {
      const settings = store?.getSettings()
      const ui = store?.getUI()
      return {
        showTasksButton: settings?.showTasksButton !== false,
        showAutomationsButton: settings?.showAutomationsButton !== false,
        showMobileButton: settings?.showMobileButton !== false,
        showTitlebarAppName: settings?.showTitlebarAppName !== false,
        statusBarVisible: ui?.statusBarVisible !== false
      }
    },
    getKeybindings: () => keybindings?.getOverrides()
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
  let serveOptions: ServeOptions | null = null
  try {
    serveOptions = isServeMode ? getServeOptions() : null
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: app.getPath('userData'),
    enableWebSocket: true,
    ...(isE2E ? { wsPort: 0 } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined ? { wsPort: serveOptions.wsPort } : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  registerMobileHandlers(runtimeRpc)

  if (!isServeMode) {
    startDesktopFirstWindowStartupServices()
  }

  if (serveOptions) {
    registerHeadlessPtyRuntime(
      runtime,
      prepareCodexRuntimeHomeForLaunch,
      () => store!.getSettings(),
      (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
      store
    )
    // Why: headless servers have no renderer graph publisher. Publish an
    // explicit empty graph so status clients see a ready server while
    // renderer-only operations still fail at their own window boundary.
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start headless RPC transport:', error)
      throw error
    })
    installServeSignalHandlers()
    await printServeReady(serveOptions)
    return
  }

  // Why: window creation and runtime RPC startup are independent. Local PTY
  // spawns are gated inside registerPtyHandlers so RPC can bind immediately
  // without racing the daemon provider swap.
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
  unsubscribeAgentAwakeStatusChanges?.()
  unsubscribeAgentAwakeStatusChanges = null
  agentAwakeService?.dispose()
  agentAwakeService = null
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
  automations?.stop()
  setUnreadDockBadgeCount(0)
  agentHookServer.stop()
  stats?.flush()
  // Why: agent-browser daemon processes would otherwise linger after Orca quits,
  // holding ports and leaving stale session state on disk.
  runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  const emulatorShutdown = runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
  serveSimStateWatcher.stop()
  killAllPty()
  const watcherShutdown = shutdownWatchersOnce()
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
          .then(() => awaitRuntimeFileWatcherUnsubscribes())
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
    // Why: normal quits preserve the detached daemon for warm reattach, but a
    // dev parent dying means the temp/dev profile has no owner left to reattach.
    const daemonTeardown = isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()
    Promise.allSettled([daemonTeardown, rpcStopAndClear, watcherShutdown, emulatorShutdown])
      .then(() => shutdownTelemetry())
      .then(() => shutdownObservability())
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
