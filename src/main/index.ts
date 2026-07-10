/* eslint-disable max-lines -- Why: this is Orca's main-process entry point;
   it owns app lifecycle, service wiring, window creation, and hook/daemon
   startup. Splitting by line count would fragment tightly coupled startup
   logic across files without a cleaner ownership seam. */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import os from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import * as QRCode from 'qrcode'
import {
  Store,
  initDataPath,
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from './persistence'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from './orca-profiles/profile-index-store'
import { applyAppIcon } from './app-icon'
import { StatsCollector, initStatsPath } from './stats/collector'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from './opencode-usage/store'
import { killAllPty } from './ipc/pty'
import { initDaemonPtyProvider, disconnectDaemon, shutdownDaemon } from './daemon/daemon-init'
import { closeAllWatchers } from './ipc/filesystem-watcher'
import { disposeWorktreeBaseDirectoryWatchers } from './ipc/worktree-base-directory-watcher'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { initObservability, shutdownObservability } from './observability'
import { startSpan } from './observability/tracer'
import { registerMobileHandlers } from './ipc/mobile'
import { initTelemetry, shutdownTelemetry, trackAppOpenedOnce, track } from './telemetry/client'
import { classifyError } from './telemetry/classify-error'
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
import { enableRendererHeapHeadroom } from './startup/renderer-heap-headroom'
import { ensureVirtualDisplayForHeadlessServe } from './startup/ensure-virtual-display'
import {
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
  type WindowsGpuFallbackEnvironment
} from './startup/gpu-fallback-marker'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate
} from './crash-reporting/gpu-crash-fallback-decision'
import {
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './startup/dev-education-suppression'
import { maybeRedirectAppImageCliLaunch } from './startup/appimage-cli-redirect'
import { maybeRedirectPackagedCliEntryLaunch } from './startup/packaged-cli-entry-redirect'
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
import { startMainThreadChurnProbe } from './diagnostics/main-thread-churn-probe'
import {
  isStartupDiagnosticsEnabled,
  logStartupDiagnostic,
  logStartupMilestone
} from './startup/startup-diagnostics'
import { ensureWindowsUserDataAclGrant } from './startup/windows-user-data-acl'
import { shouldQuitWhenAllWindowsClosed } from './startup/window-all-closed-quit-policy'
import { RateLimitService } from './rate-limits/service'
import { readMiniMaxSessionCookie } from './minimax/minimax-cookie-store'
import { getInitialClaudeRateLimitTarget } from './rate-limits/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './rate-limits/codex-rate-limit-target'
import {
  attachMainWindowServices,
  ensureAutoUpdaterConfigured
} from './window/attach-main-window-services'
import { createMainWindow, loadMainWindow } from './window/createMainWindow'
import { createSystemTray, destroySystemTray, setTrayAttention } from './tray/system-tray'
import { focusExistingMainWindow } from './window/focus-existing-window'
import { notifyMainWindowBecameVisible } from './window/main-window-visibility'
import { CodexAccountService } from './codex-accounts/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from './claude-accounts/runtime-selection'
import { codexHookService } from './codex/hook-service'
import { getDefaultWslDistro } from './wsl'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import {
  attachClaudeLivePtyPersistence,
  seedLiveClaudePtysFromPersistence
} from './claude-accounts/live-pty-gate'
import { StarNagService } from './star-nag/service'
import { agentHookServer } from './agent-hooks/server'
import { maybeAutoRenameBranchOnFirstWork } from './agent-hooks/first-work-branch-rename'
import { renameWorktreeFolderOnFirstWork } from './agent-hooks/first-work-folder-rename'
import { moveWorktree } from './git/worktree'
import { getRepoIdFromWorktreeId } from '../shared/worktree-id'
import { parseWorkspaceKey } from '../shared/workspace-scope'
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
import { OffscreenBrowserBackend } from './browser/offscreen-browser-backend'
import { initializeBrowserSessionsForApp } from './browser/browser-session-startup'
import { setUnreadDockBadgeCount } from './dock/unread-badge'
import { AutomationService } from './automations/service'
import { createHeadlessAutomationOutputSnapshotBuffer } from './automations/headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from './automations/headless-workspace-create'
import { AgentAwakeService } from './agent-awake-service'
import { registerSystemResumeBroadcast } from './system-resume-broadcast'
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
import { resolveTuiAgentPermissionMode } from '../shared/tui-agent-permissions'
import { KeybindingService } from './keybindings/keybinding-service'
import { applyElectronProxySettings } from './network/proxy-settings'
import { preserveAgentAuthBeforeRestart } from './agent-auth-restart-preservation'
import { CliInstaller } from './cli/cli-installer'
import { installLinuxBareOrcaDispatcher } from './cli/linux-bare-orca-dispatcher'
import { selfHealRuntimeEnvironmentFocus } from './runtime-environment-focus-self-heal'

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
// Why: set during early startup; gates whether headless serve installs the
// offscreen browser backend (and thus advertises browser pane support).
let headlessBrowserDisplayAvailable = false

let starNag: StarNagService | null = null
let agentAwakeService: AgentAwakeService | null = null
let crashReports: CrashReportStore | null = null
let unsubscribeAgentAwakeStatusChanges: (() => void) | null = null
let unsubscribeSystemResumeBroadcast: (() => void) | null = null
let watcherShutdownPromise: Promise<void> | null = null
let watcherShutdownDone = false
let automations: AutomationService | null = null
let keybindings: KeybindingService | null = null
// Why: a reload/teardown intent set for one renderer must not leak to a later load.
// The recovery reload re-fires did-finish-load, so its flag lets the local-PTY orphan
// sweep spare live sessions across that one reload (#5787).
const expectedRendererReload = createWebContentsTimedFlag()
const recoveryReloadInFlight = createWebContentsTimedFlag()
let firstWindowStartupServicesReady: Promise<void> = Promise.resolve()
// Why: GPU child crashes clustered right after launch indicate a broken driver;
// track them so Orca can move this build onto software rendering.
const gpuLaunchTimeMs = Date.now()
const gpuCrashFallbackTracker = new GpuCrashFallbackTracker({
  windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
})
let gpuFallbackActiveThisLaunch = false
let localPtyStartupReady: Promise<void> = Promise.resolve()
const AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS = 30_000
const isServeMode = process.argv.includes('--serve')
// Why: on Windows a CLI-shaped launch (Orca.exe <unpacked CLI entry>) that lost
// ELECTRON_RUN_AS_NODE would otherwise boot the GUI, lose the single-instance
// lock to a running window, and exit silently. Redirect it to node mode here,
// before the lock gate below can bounce it.
const packagedCliEntryRedirect = maybeRedirectPackagedCliEntryLaunch({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath
})
if (packagedCliEntryRedirect.redirected) {
  app.exit(packagedCliEntryRedirect.status)
}
const appImageCliRedirect = maybeRedirectAppImageCliLaunch({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath
})
if (appImageCliRedirect.redirected) {
  app.exit(appImageCliRedirect.status)
}

// Kill switch for the first-work on-disk folder rename. The renderer reconciles a
// worktree id change via migrateWorktreeIdentity + a rename-aware worktrees:changed
// handler, so an old->new id change is no longer mistaken for a deletion. Flip off
// to disable the on-disk move (branch + display rename still happen) if needed.
const ENABLE_FIRST_WORK_FOLDER_RENAME = false

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
      getCurrentDisplayName: (worktreeId) => {
        const scope = parseWorkspaceKey(worktreeId)
        if (scope?.type === 'folder') {
          return currentStore.getFolderWorkspace(scope.folderWorkspaceId)?.name
        }
        return currentStore.getWorktreeMeta(worktreeId)?.displayName
      },
      getFolderWorkspacePath: (worktreeId) => {
        const scope = parseWorkspaceKey(worktreeId)
        return scope?.type === 'folder'
          ? currentStore.getFolderWorkspace(scope.folderWorkspaceId)?.folderPath
          : undefined
      },
      isPendingFirstAgentMessageRename: (worktreeId) => {
        const scope = parseWorkspaceKey(worktreeId)
        if (scope?.type === 'folder') {
          return (
            currentStore.getFolderWorkspace(scope.folderWorkspaceId)
              ?.pendingFirstAgentMessageRename === true
          )
        }
        return currentStore.getWorktreeMeta(worktreeId)?.pendingFirstAgentMessageRename === true
      },
      canRenameOrcaCreatedBranch: (worktreeId) => {
        const meta = currentStore.getWorktreeMeta(worktreeId)
        // Why: a user/imported branch can coincidentally be named after a creature.
        // Only worktrees Orca stamped at creation are safe to auto-rename.
        return !!meta?.orcaCreationSource && meta.preserveBranchOnDelete !== true
      },
      setDisplayName: (worktreeId, displayName) => {
        const scope = parseWorkspaceKey(worktreeId)
        if (scope?.type === 'folder') {
          currentStore.updateFolderWorkspace(scope.folderWorkspaceId, {
            name: displayName,
            pendingFirstAgentMessageRename: false,
            firstAgentMessageRenameError: null
          })
          currentRuntime.notifyFolderWorkspaceChanged()
          return
        }
        currentStore.setWorktreeMeta(worktreeId, {
          displayName,
          pendingFirstAgentMessageRename: false,
          // Success always clears the failure badge, even if the explicit
          // setRenameError(null) clear is redundant.
          firstAgentMessageRenameError: null
        })
      },
      renameWorktreeFolder: ENABLE_FIRST_WORK_FOLDER_RENAME
        ? (worktreeId, newLeaf) =>
            renameWorktreeFolderOnFirstWork(worktreeId, newLeaf, {
              getRepo: (repoId) => currentStore.getRepo(repoId),
              getSettings: () => currentStore.getSettings(),
              migrateWorktreeIdentity: (oldId, newId) =>
                currentStore.migrateWorktreeIdentity(oldId, newId),
              notifyWorktreeRenamed: (repoId, oldId, newId) =>
                currentRuntime.notifyWorktreeFolderRenamed(repoId, oldId, newId),
              pathExists: async (candidate) => existsSync(candidate),
              moveWorktree
            })
        : undefined,
      setRenameError: (worktreeId, error) => {
        // Skip the write + renderer push when nothing changes — benign skips
        // clear the error on every settled worktree, most of which never had one.
        const scope = parseWorkspaceKey(worktreeId)
        if (scope?.type === 'folder') {
          const current = currentStore.getFolderWorkspace(
            scope.folderWorkspaceId
          )?.firstAgentMessageRenameError
          if ((current ?? null) === (error ?? null)) {
            return
          }
          currentStore.updateFolderWorkspace(scope.folderWorkspaceId, {
            firstAgentMessageRenameError: error
          })
          currentRuntime.notifyFolderWorkspaceChanged()
          return
        }
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
      onRenamed: (repoIdOrWorktreeId) => {
        if (parseWorkspaceKey(repoIdOrWorktreeId)?.type === 'folder') {
          currentRuntime.notifyFolderWorkspaceChanged()
          return
        }
        currentRuntime.notifyBranchRenamed(repoIdOrWorktreeId)
      }
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

// Why: just past createMainWindow's win32 10s ready-to-show reveal fallback,
// so a window revealed on that path still gets its tray icon.
const TRAY_CREATE_FALLBACK_MS = 12_000

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
// Self-gated on ORCA_MAIN_THREAD_DIAGNOSTICS; unlike the startup probe it
// runs for the whole session to catch steady-state churn (issue #7576).
startMainThreadChurnProbe()

function focusExistingWindow(): void {
  focusExistingMainWindow({
    app,
    getWindow: () => mainWindow,
    openWindow: openMainWindow,
    warn: console.warn
  })
}

// Why: a webContents-scoped flag that auto-expires so an intent set for one renderer
// can't leak to a later load. `consume` clears on a positive match for one-shot
// signals (the recovery reload fires exactly one did-finish-load).
function createWebContentsTimedFlag(defaultDurationMs = 10_000): {
  mark: (webContentsId: number, durationMs?: number) => void
  clear: (webContentsId?: number) => void
  matches: (webContentsId: number, options?: { consume?: boolean }) => boolean
} {
  let state: { webContentsId: number; until: number } | null = null
  return {
    mark(webContentsId, durationMs = defaultDurationMs) {
      state = { webContentsId, until: Date.now() + durationMs }
    },
    clear(webContentsId) {
      if (webContentsId === undefined || state?.webContentsId === webContentsId) {
        state = null
      }
    },
    matches(webContentsId, options) {
      if (!state || Date.now() > state.until) {
        state = null
        return false
      }
      if (state.webContentsId !== webContentsId) {
        return false
      }
      if (options?.consume) {
        state = null
      }
      return true
    }
  }
}

function markExpectedRendererReload(webContentsId: number, durationMs = 10_000): void {
  expectedRendererReload.mark(webContentsId, durationMs)
}

function clearExpectedRendererReload(webContentsId?: number): void {
  expectedRendererReload.clear(webContentsId)
}

function getExpectedTeardownScope(webContentsId?: number): ExpectedTeardownScope {
  if (isQuitting || isQuittingForUpdate()) {
    return 'app-shutdown'
  }
  if (webContentsId === undefined) {
    return 'none'
  }
  return expectedRendererReload.matches(webContentsId) ? 'renderer-reload' : 'none'
}

function markRecoveryReloadInFlight(webContentsId: number, durationMs = 10_000): void {
  recoveryReloadInFlight.mark(webContentsId, durationMs)
}

function isRecoveryReloadInFlight(webContentsId: number): boolean {
  // Why: consume on read — the recovery reload fires exactly one did-finish-load,
  // so a later genuine reload still sweeps orphaned local PTYs.
  return recoveryReloadInFlight.matches(webContentsId, { consume: true })
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
  initOrcaProfilePaths()
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
  enableRendererHeapHeadroom()
  maybeApplyGpuFallbackForThisLaunch()
  if (!gpuFallbackActiveThisLaunch) {
    enableMainProcessGpuFeatures()
  }
  // Why: headless serve backs browser panes with offscreen BrowserWindows, which
  // need an X display on Linux. Ensure one (Xvfb) before whenReady; the result
  // gates whether the offscreen backend is installed so capability stays honest.
  headlessBrowserDisplayAvailable = ensureVirtualDisplayForHeadlessServe({ isServeMode })
}

ipcMain.handle('app:awaitFirstWindowStartupServices', async () => {
  await firstWindowStartupServicesReady
})

ipcMain.handle(
  'app:startupDiagnostic',
  (_event, event: string, details?: Record<string, unknown>) => {
    if (!startupDiagnosticsEnabled || !event.startsWith('renderer-')) {
      return
    }
    logStartupMilestone(event, details && typeof details === 'object' ? details : {})
  }
)

function startDesktopFirstWindowStartupServices(): Promise<void> {
  logStartupMilestone('first-window-startup-services-start')
  const startupServices = startFirstWindowStartupServices({
    // Why: the persistent-terminal daemon is desktop-only. Headless `orca serve`
    // registers its PTY runtime separately and must not spawn the desktop daemon
    // or hook loopback listener.
    startDaemonPtyProvider: async (signal) => {
      logStartupMilestone('startup-service-start', { service: 'daemon-pty-provider' })
      await initDaemonPtyProvider(signal)
      logStartupMilestone('startup-service-done', { service: 'daemon-pty-provider' })
    },
    // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from the live server state, so
    // the renderer awaits this barrier before restored terminals reconnect.
    startAgentHookServer: async () => {
      logStartupMilestone('startup-service-start', { service: 'agent-hook-server' })
      await agentHookServer.start({
        env: app.isPackaged ? 'production' : 'development',
        // Why: hooks source this endpoint file at invocation time, so old PTY
        // env still reaches the current Orca process after an app restart.
        // Dev uses a namespace because all worktrees share `orca-dev`.
        userDataPath: app.getPath('userData'),
        endpointNamespace: devAgentHookEndpointNamespace
      })
      logStartupMilestone('startup-service-done', { service: 'agent-hook-server' })
    },
    onDaemonError: (error) => {
      // Why: daemon startup failure silently dropped terminals onto the local
      // provider (killed on quit, no persistence) — the v1.4.129-rc.1 outage was
      // invisible in the field. Log loudly (error.message carries the captured
      // daemon stderr tail from the fork) and emit a low-cardinality telemetry
      // signal so a fleet-wide daemon failure is observable without a bug report.
      const reason = error instanceof Error ? error.message : String(error)
      console.error(
        `[daemon] STARTUP FAILED — falling back to local PTYs; terminals will not persist across quit. Reason: ${reason}`
      )
      track('daemon_start_failed', classifyError(error))
    },
    onAgentHookServerError: (error) => {
      // Why: Claude/Codex/Gemini/OpenCode/Cursor hook callbacks are sidebar
      // enrichment only. Orca must still boot if the loopback receiver fails.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })
  firstWindowStartupServicesReady = startupServices.firstWindowReady
  localPtyStartupReady = startupServices.localPtyReady
  void firstWindowStartupServicesReady.then(() => {
    logStartupMilestone('first-window-startup-services-ready')
  })
  void localPtyStartupReady.then(() => {
    logStartupMilestone('local-pty-startup-ready')
  })
  return firstWindowStartupServicesReady
}

async function startServeAgentHookServer(): Promise<void> {
  if (!isAgentStatusHooksEnabled(store?.getSettings())) {
    return
  }
  try {
    await agentHookServer.start({
      env: app.isPackaged ? 'production' : 'development',
      userDataPath: app.getPath('userData'),
      endpointNamespace: devAgentHookEndpointNamespace
    })
  } catch (error) {
    // Why: remote hook callbacks enrich agent status only. A headless runtime
    // should still serve terminals if the loopback receiver cannot bind.
    console.error('[agent-hooks] Failed to start serve hook server:', error)
  }
}

function prepareCodexRuntimeHomeForLaunch(target?: CodexAccountSelectionTarget): string | null {
  const runtimeHomePath = codexRuntimeHome!.prepareForCodexLaunch(target)
  const hookTarget =
    target?.runtime === 'wsl'
      ? {
          runtime: 'wsl' as const,
          wslDistro: target.wslDistro?.trim() || getDefaultWslDistro()
        }
      : target
  const hooksEnabled = isAgentStatusHooksEnabled(store?.getSettings())
  try {
    // Why: launch prep is reachable after startup via PTY/runtime paths; honor
    // the persisted off switch so those launches cannot reinstall removed hooks.
    const status = hooksEnabled
      ? (codexHookService.installForRuntimeHome(runtimeHomePath, hookTarget) ??
        codexHookService.install())
      : (codexHookService.refreshRuntimeUserHooksForRuntimeHome(runtimeHomePath, hookTarget) ??
        codexHookService.refreshRuntimeUserHooks())
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

// Why: tray "Open Orca" / left-click restores the window the close handler may
// have hidden to the tray; if the window was fully torn down, reopen it the
// same way macOS dock re-activation does (guarded against update relaunch).
function showMainWindowFromTray(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (!isQuittingForUpdate()) {
    openMainWindow()
  }
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
    onRendererRecoveryExhausted: ({ details, recentRecoveryCount }) => {
      recordCrashBreadcrumb('renderer_recovery_circuit_breaker_open', {
        reason: details.reason,
        exitCode: details.exitCode ?? null,
        recentRecoveryCount
      })
      void presentRendererRecoveryPrompt(recentRecoveryCount)
    },
    deferLoad: true,
    title: devInstanceIdentity.name,
    getKeybindings: () => keybindings?.getOverrides(),
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (mainWindow?.webContents.id === webContentsId) {
        markExpectedRendererReload(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    },
    // Why: the in-place recovery reload re-fires did-finish-load; flag it so the
    // local-PTY orphan sweep is skipped for that one reload (#5787).
    onBeforeRecoveryReload: (webContentsId) => {
      markRecoveryReloadInFlight(webContentsId)
      recordCrashBreadcrumb('renderer_recovery_reload')
    }
  })
  recordCrashBreadcrumb('main_window_created')
  logStartupMilestone('window-created')
  // Why: new Tray() is a synchronous Shell_NotifyIcon call that can block for
  // seconds while explorer.exe's notification area is busy (part of issue
  // #7225's pre-paint stall), so create it after first paint. The timer
  // fallback covers windows revealed without ready-to-show ever firing
  // (createMainWindow's win32 10s reveal fallback) — those can still be
  // hidden to the tray on close, so the icon must exist by then.
  let trayCreated = false
  const createSystemTrayDeferred = (): void => {
    if (trayCreated || window.isDestroyed() || isQuitting || !store) {
      return
    }
    trayCreated = true
    // Why: Windows-only system tray. createSystemTray is idempotent and a
    // no-op off win32, so calling it on each window open keeps exactly one
    // live icon.
    createSystemTray({
      appIcon: store.getSettings().appIcon,
      onOpen: showMainWindowFromTray,
      onQuit: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Why: a real quit can still surface renderer save/discard prompts;
          // the window must be visible if a hidden-to-tray session vetoes
          // shutdown.
          showMainWindowFromTray()
        }
        // Why: set the quit latch before app.quit() so the window 'close'
        // handler proceeds to teardown instead of re-hiding to the tray.
        isQuitting = true
        app.quit()
      }
    })
    logStartupMilestone('tray-created')
  }
  window.once('ready-to-show', () => {
    logStartupMilestone('ready-to-show')
    setImmediate(createSystemTrayDeferred)
  })
  const trayCreateFallback = setTimeout(createSystemTrayDeferred, TRAY_CREATE_FALLBACK_MS)
  trayCreateFallback.unref?.()

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
      prepareForClaudeLaunch: (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target)
    },
    agentAwakeService ?? undefined,
    crashReports ?? undefined,
    keybindings,
    {
      getAdditionalAiVaultCodexHomePaths: () =>
        codexRuntimeHome ? [codexRuntimeHome.getHostRuntimeHomePath()] : [],
      onBeforeRelaunch: async () => {
        isQuitting = true
        await preserveAgentAuthBeforeRestart({ codexRuntimeHome, claudeRuntimeAuth, store })
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
      },
      // Why: let the PTY layer skip its orphan sweep on the one recovery reload
      // that re-fires did-finish-load, so live local sessions survive it (#5787).
      isRecoveryReloadInFlight,
      onBeforeUpdateQuit: () =>
        preserveAgentAuthBeforeRestart({ codexRuntimeHome, claudeRuntimeAuth, store })
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
  // Why: visibility-gated main-process pollers (SSH port scanner) park while
  // hidden and rely on this signal to resume; re-wired per window because
  // macOS dock re-activation recreates the BrowserWindow.
  window.on('show', notifyMainWindowBecameVisible)
  window.on('restore', notifyMainWindowBecameVisible)
  // Why: showing/restoring the window means the user is back, so clear the
  // tray attention dot set while it was minimized/hidden (see notifications.ts).
  window.on('show', () => setTrayAttention(false))
  window.on('restore', () => setTrayAttention(false))
  agentHookServer.setListener(
    ({
      paneKey,
      tabId,
      worktreeId,
      connectionId,
      payload,
      receivedAt,
      stateStartedAt,
      launchToken,
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
        ...(launchToken ? { launchToken } : {}),
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
      const suppressSyntheticCodexAutoApprovalTitle =
        payload.agentType === 'codex' &&
        (payload.state === 'waiting' || payload.state === 'blocked')
          ? shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
              agentType: payload.agentType,
              state: payload.state,
              launchConfig: runtime?.getAgentStatusLaunchConfigForPaneKey(paneKey, { launchToken })
            })
          : false
      if (
        profile &&
        shouldDriveSyntheticAgentTitleFromHook(payload.agentType, payload.state) &&
        !suppressSyntheticCodexAutoApprovalTitle
      ) {
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

// Why: when the renderer crash-loops, the breaker stops auto-reloading and the
// window is left blank. The renderer is dead, so a main-process dialog is the
// only surface that can offer a retry or a clean quit instead of a silent loop.
async function presentRendererRecoveryPrompt(recentRecoveryCount: number): Promise<void> {
  if (isQuitting) {
    return
  }
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const options = {
    type: 'error' as const,
    buttons: ['Reload', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    title: 'Orca keeps failing to load',
    message: 'The app window crashed repeatedly and stopped reloading automatically.',
    detail: `Orca tried to recover ${recentRecoveryCount} times in a row without success. This is often a graphics-driver or installation problem. Reload to try again, or quit and relaunch Orca.`
  }
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
    recordCrashBreadcrumb('renderer_recovery_manual_retry')
    loadMainWindow(mainWindow)
  } else if (response === 1) {
    isQuitting = true
    app.quit()
  }
}

function getGpuFallbackEnvironment(): GpuFallbackEnvironment {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    platform: process.platform
  }
}

function getWindowsGpuFallbackEnvironment(): WindowsGpuFallbackEnvironment | null {
  const environment = getGpuFallbackEnvironment()
  if (environment.platform !== 'win32') {
    return null
  }
  return { ...environment, platform: 'win32' }
}

// Why: the GPU-fallback marker must be read before app.whenReady() resolves so
// app.disableHardwareAcceleration() can take effect. Windows desktop only -
// headless serve already runs software rendering on the platforms that need it.
function maybeApplyGpuFallbackForThisLaunch(): void {
  if (isServeMode || process.platform !== 'win32') {
    return
  }
  const marker = readActiveGpuFallbackMarker(app.getPath('userData'), getGpuFallbackEnvironment())
  if (!marker) {
    return
  }
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  gpuFallbackActiveThisLaunch = true
  recordCrashBreadcrumb('gpu_fallback_applied', {
    crashesInWindow: marker.crashesInWindow
  })
}

// Why: a burst of crash-shaped Windows GPU child failures right after launch
// means hardware acceleration is unusable on this machine. Persist a build-
// scoped marker and relaunch into software rendering instead of looping crashes.
function handleGpuChildCrash(reason: string, exitCode: number | null): void {
  // Software rendering already active or shutting down: nothing more to do.
  if (gpuFallbackActiveThisLaunch || isQuitting || isServeMode) {
    return
  }
  const result = gpuCrashFallbackTracker.recordGpuCrash(Date.now() - gpuLaunchTimeMs)
  if (!result.shouldEngageFallback) {
    return
  }
  recordCrashBreadcrumb('gpu_fallback_engaged', {
    reason,
    exitCode,
    crashesInWindow: result.crashesInWindow
  })
  const engagedAt = Date.now()
  const environment = getWindowsGpuFallbackEnvironment()
  if (!environment) {
    return
  }
  try {
    writeGpuFallbackMarker(
      app.getPath('userData'),
      {
        engagedAt,
        crashesInWindow: result.crashesInWindow
      },
      environment
    )
  } catch (error) {
    console.warn('[gpu-fallback] failed to persist marker:', error)
    return
  }
  isQuitting = true
  app.relaunch()
  app.exit(0)
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
  const key = getProcessGoneDedupeKey(source, processType, reason, exitCode)
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
    watcherShutdownPromise = Promise.allSettled([
      closeAllWatchers(),
      disposeWorktreeBaseDirectoryWatchers()
    ])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[filesystem-watcher] shutdown failed:', result.reason)
          }
        }
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
  recipeJson: boolean
  projectRoot: string | null
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
    mobilePairing: argv.includes('--serve-mobile-pairing'),
    recipeJson: argv.includes('--serve-recipe-json'),
    projectRoot: valueAfter('--serve-project-root')
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
  if (options.recipeJson) {
    if (!options.projectRoot) {
      throw new Error('--serve-recipe-json requires --serve-project-root')
    }
    if (!isAbsolute(options.projectRoot)) {
      throw new Error(`--serve-project-root must be absolute: ${options.projectRoot}`)
    }
    const projectRootStats = statSync(options.projectRoot)
    if (!projectRootStats.isDirectory()) {
      throw new Error(`--serve-project-root must be a directory: ${options.projectRoot}`)
    }
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
  if (options.recipeJson) {
    if (!pairing.available) {
      throw new Error('Recipe JSON output requires runtime pairing to be available')
    }
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        pairingCode: pairing.pairingUrl,
        projectRoot: options.projectRoot
      })
    )
    return
  }
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

function shouldSuppressCodexAutoApprovalSyntheticTitleFromHook(args: {
  agentType: string | null | undefined
  state: AgentStatusState
  launchConfig:
    | {
        agentArgs?: string | null
        agentEnv?: Record<string, string> | null
      }
    | null
    | undefined
}): boolean {
  if (args.agentType !== 'codex' || (args.state !== 'waiting' && args.state !== 'blocked')) {
    return false
  }
  if (!args.launchConfig) {
    return false
  }
  return (
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: args.launchConfig.agentArgs,
      agentEnv: args.launchConfig.agentEnv
    }) === 'yolo'
  )
}

app.whenReady().then(async () => {
  logStartupMilestone('app-ready')
  electronApp.setAppUserModelId(devInstanceIdentity.appUserModelId)
  app.setName(devInstanceIdentity.name)

  const activeOrcaProfile = ensureActiveOrcaProfile()
  store = new Store({ dataFile: activeOrcaProfile.dataFile })
  logStartupMilestone('store-loaded')
  // Why: must run before ClaudeRuntimeAuthService's constructor sync — a Claude
  // CLI that survived the restart inside the daemon still holds the current
  // single-use refresh token, and an unguarded early refresh would rotate it
  // out from under that process (it then shows "Not logged in" mid-session).
  attachClaudeLivePtyPersistence(store)
  const persistedClaudePtyIds = store.getClaudeLivePtySessionIds()
  seedLiveClaudePtysFromPersistence(persistedClaudePtyIds)
  if (persistedClaudePtyIds.length > 0) {
    console.log(
      `[claude-live-pty] Seeded ${persistedClaudePtyIds.length} persisted Claude session id(s) into the refresh gate`
    )
  }
  selfHealRuntimeEnvironmentFocus({ store, userDataPath: app.getPath('userData') })
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
  initializeBrowserSessionsForApp({
    orcaProfileId: activeOrcaProfile.profile.id,
    profileDirectory: activeOrcaProfile.profileDirectory
  })
  unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
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
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store!.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  })
  rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store!.getSettings()
    return {
      sessionCookie: readMiniMaxSessionCookie() ?? '',
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels
    }
  })
  rateLimits.setGeminiCliOAuthEnabledResolver(() => store!.getSettings().geminiCliOAuthEnabled)
  rateLimits.setNetworkProxySettingsResolver(() => store!.getSettings())
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
    },
    // Why: hook-reported agent status is the same source the desktop sidebar
    // reads. worktree.ps pulls it at query time so mobile shows the same agents.
    getAgentStatusSnapshot: () => agentHookServer.getStatusSnapshot(),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store?.getSettings()) ? agentHookServer.buildPtyEnv() : {}
  })
  runtime = runtimeService
  automations = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    // Why: desktop clients may mirror remote-host automations, but only a
    // server process should execute schedules owned by `remote_host_service`.
    allowRemoteHostScheduling: isServeMode,
    headlessDispatcher: isServeMode
      ? async ({ automation, run, target }) => {
          const terminalSnapshotLimit = 2_000
          let terminalHandle: string
          let terminalSessionId: string | null = null
          let terminalPaneKey: string | null = null
          let terminalPtyId: string | null = null
          let workspaceId: string
          let workspaceDisplayName: string | null = null

          if (automation.workspaceMode === 'new_per_run') {
            const created = await runtimeService.createManagedWorktree({
              ...buildHeadlessAutomationWorktreeCreateArgs({
                automation,
                run,
                repo: target.repo
              })
            })
            terminalHandle = created.startupTerminal?.handle ?? ''
            terminalSessionId = created.startupTerminal?.tabId ?? null
            terminalPaneKey = created.startupTerminal?.paneKey ?? null
            terminalPtyId = created.startupTerminal?.ptyId ?? null
            workspaceId = created.worktree.id
            workspaceDisplayName = created.worktree.displayName ?? null
            if (!terminalHandle) {
              throw new Error(
                created.warning ||
                  'Automation workspace was created, but no agent terminal started.'
              )
            }
          } else {
            if (!automation.workspaceId) {
              throw new Error('The target workspace is no longer available.')
            }
            const terminal = await runtimeService.launchAgentTerminal(
              `id:${automation.workspaceId}`,
              {
                agent: automation.agentId,
                prompt: automation.prompt,
                title: run.title
              }
            )
            terminalHandle = terminal.handle
            terminalSessionId = terminal.tabId ?? null
            terminalPaneKey = terminal.paneKey ?? null
            terminalPtyId = terminal.ptyId ?? null
            workspaceId = terminal.worktreeId
            const worktree = await runtimeService.showManagedWorktree(`id:${workspaceId}`)
            workspaceDisplayName = worktree.displayName ?? null
          }

          const completion = (async () => {
            const wait = await runtimeService.waitForTerminal(terminalHandle, {
              condition: 'tui-idle'
            })
            const read = await runtimeService.readTerminal(terminalHandle, {
              limit: terminalSnapshotLimit
            })
            const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
            snapshotBuffer.append(read.tail.join('\n'))
            if (wait.satisfied) {
              return {
                status: 'completed' as const,
                outputSnapshot: snapshotBuffer.snapshot(),
                error: null
              }
            }
            return {
              status: 'dispatch_failed' as const,
              outputSnapshot: snapshotBuffer.snapshot(),
              error: wait.blockedReason
                ? `Automation agent is blocked: ${wait.blockedReason}.`
                : 'Automation agent did not report completion.'
            }
          })()

          return {
            workspaceId,
            workspaceDisplayName,
            terminalSessionId,
            terminalPaneKey,
            terminalPtyId,
            completion
          }
        }
      : undefined
  })
  runtimeService.setAutomationService(automations)
  runtimeService.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtimeService.setCommitMessageAgentEnvironmentResolvers({
    // Why: local Codex hooks and auth now live in Orca's managed runtime home
    // even for the system-default path, so every Orca-launched Codex process
    // must resolve CODEX_HOME through the runtime-home service.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target)
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
    if (
      isGpuFallbackCrashCandidate({
        platform: process.platform,
        processType: details.type,
        reason: details.reason
      })
    ) {
      handleGpuChildCrash(details.reason, details.exitCode ?? null)
    }
  })

  logStartupMilestone('services-initialized')
  await ensureMainI18n()
  await setMainUiLanguage(store.getSettings().uiLanguage)
  logStartupMilestone('i18n-ready')

  registerAppMenu({
    onCheckForUpdates: (options) => {
      // Why: the menu is clickable before first paint; a manual check must
      // run against a configured updater (see attach-main-window-services).
      ensureAutoUpdaterConfigured()
      return checkForUpdatesFromMenu(options)
    },
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
  // ws-transport's EADDRINUSE handler. Note: once an instance has ever fallen
  // back, the persisted fallback port is re-bound in preference to 6769
  // (STA-1511) until mobile-ws-fallback-port.json is removed from userData.
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  let serveOptions: ServeOptions | null = null
  try {
    serveOptions = isServeMode ? getServeOptions() : null
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  // Why: existing installs may have already written mobile pairing credentials
  // under the late app.getPath('userData') directory. Copy any missing files
  // forward before the runtime switches exclusively to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Why: mobile pairing (DeviceRegistry + E2EE keypair + runtime metadata)
    // must share the stable path captured before app.setName(), not a late
    // app.getPath('userData') that resolves elsewhere and drops paired devices
    // across restarts/updates. See persistence.ts:getCanonicalUserDataPath.
    userDataPath: getCanonicalUserDataPath(),
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
    await startServeAgentHookServer()
    registerHeadlessPtyRuntime(
      runtime,
      prepareCodexRuntimeHomeForLaunch,
      () => store!.getSettings(),
      (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
      store
    )
    // Why: headless servers have no renderer to mount <webview> browser panes.
    // Back them with main-process offscreen WebContents instead, so this host can
    // own browser pages and advertise browser.headless.v1 — but only when a
    // display is actually available (set up above), so the capability stays honest.
    if (headlessBrowserDisplayAvailable) {
      runtime.setOffscreenBrowserBackend(new OffscreenBrowserBackend(browserManager))
    }
    // Why: headless servers have no renderer graph publisher. Publish an
    // explicit empty graph so status clients see a ready server while
    // renderer-only operations still fail at their own window boundary.
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start headless RPC transport:', error)
      throw error
    })
    installServeSignalHandlers()
    // Why: the orca CLI command is normally installed by the renderer onboarding /
    // Settings "Install CLI" flow via the cli:install IPC. Headless serve has no
    // renderer, so the command is never created and an in-terminal `orca …` fails
    // with command-not-found. Run the idempotent installer here for the platforms
    // where it puts a resolvable command on the managed-terminal PATH: macOS (bare
    // `orca` in /usr/local/bin or ~/.local/bin) and Linux (`orca-ide`; bare `orca`
    // is added by the dispatcher below). Windows is excluded — there install() would
    // only mutate the persistent user-registry PATH without helping the current
    // serve's child terminals. Best-effort: a failure must not block serve start.
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        // Why: serve is headless — never let a missing-write-permission fallback
        // pop an osascript admin prompt (it would hang serve on a GUI host). Skip
        // instead; the user-writable ~/.local/bin path needs no elevation anyway.
        const cliStatus = await new CliInstaller({
          privilegedRunner: async () => {
            throw new Error('serve CLI auto-install must not request administrator privileges')
          }
        }).install()
        console.log(
          `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
        )
      } catch (error) {
        console.warn(
          '[serve] orca CLI install skipped:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    // Why: on Linux the CLI installs as `orca-ide`, NOT bare `orca` (above), but the
    // Claude Team launcher typed into the initial managed terminal invokes bare `orca`.
    // Drop a bare-`orca` dispatcher on ~/.local/bin (ahead of /usr/bin on the managed
    // terminal PATH) so `orca claude-teams` resolves. Best-effort: a failure must not
    // block serve startup. See installLinuxBareOrcaDispatcher for the full rationale.
    if (process.platform === 'linux' && app.isPackaged && process.resourcesPath) {
      try {
        const dispatcher = await installLinuxBareOrcaDispatcher({
          resourcesPath: process.resourcesPath
        })
        console.log(
          `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
            `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
        )
      } catch (error) {
        console.warn(
          '[serve] bare orca dispatcher install skipped:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    // Why: headless serve never opens a renderer, so arm scheduled automation dispatch here.
    automations.start()
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
  unsubscribeSystemResumeBroadcast?.()
  unsubscribeSystemResumeBroadcast = null
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
  // Why: before-quit can still be aborted by renderer beforeunload; wait until
  // the committed quit path before removing the Windows notification icon.
  destroySystemTray()
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
  // Why: headless offscreen browser windows are main-process owned; tear them
  // down explicitly on quit alongside the other browser/session shutdowns.
  runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
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
              // Why: must match the path the runtime server wrote metadata to
              // (getCanonicalUserDataPath), not late app.getPath('userData').
              clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
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
  // Why: headless `orca serve` has no desktop window, and offscreen browser
  // windows are disposable implementation details. Closing/crashing the last
  // one must not take down terminal/runtime RPC for the VM workspace — the
  // policy fn returns false for serve mode so the app stays alive.
  //
  // Why: on macOS, closing all windows normally keeps the app alive (dock
  // stays active). But when a quit is in progress (Cmd+Q), the window close
  // handler defers to the renderer for buffer capture, which cancels the
  // original quit sequence. Re-trigger quit here so the app actually exits
  // instead of requiring a second Cmd+Q.
  if (
    shouldQuitWhenAllWindowsClosed({
      platform: process.platform,
      isQuitting,
      isServeMode
    })
  ) {
    app.quit()
  }
})
