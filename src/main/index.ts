/* eslint-disable max-lines -- main-process entry point; owns app lifecycle, service wiring, window creation, and hook/daemon startup with no cleaner split seam. */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import os from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type Tray } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import * as QRCode from 'qrcode'
import {
  Store,
  initDataPath,
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from './persistence'
import { initSessionParseCachePersistence } from './ai-vault/session-parse-cache-persistence'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from './orca-profiles/profile-index-store'
import { getOrcaCloudAuthConfig } from './orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from './orca-profiles/profile-storage-paths'
import { applyAppIcon } from './app-icon'
import { relaunchApp } from './app-relaunch'
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
import { loadAgentSessionClaimSigner } from './runtime/agent-session-claim-identity'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from './runtime/pairing-endpoint'
import { ServeReadinessPublisher } from './server/serve-readiness'
import { reserveServeStdoutForReadiness } from './server/serve-stdout-boundary'
import { DesktopRelayService } from './runtime/relay/desktop-relay-service'
import type { RelayBrokerStatus } from './runtime/relay/relay-session-broker'
import { awaitRuntimeFileWatcherUnsubscribes } from './runtime/orca-runtime-files'
import { clearRuntimeMetadataIfOwned } from './runtime/runtime-metadata'
import { ensureMainI18n, setMainUiLanguage } from './i18n/main-i18n'
import {
  getNextDefaultOnAppearanceSettingValue,
  registerAppMenu,
  rebuildAppMenu
} from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate, resolveUpdateInstallMode } from './updater'
import type { TuiAgent, UpdateCheckOptions } from '../shared/types'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import {
  installServeSupervisorDisconnectQuit,
  notifyServeSupervisorReady
} from './serve-update-handoff'
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
import { createWslCliReconciliationStartupBarrier } from './startup/wsl-cli-reconciliation-startup-barrier'
import { getDevInstanceIdentity } from './startup/dev-instance-identity'
import { hydrateShellPath, mergePathSegments } from './startup/hydrate-shell-path'
import {
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock
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
import { createServeDesktopActivationGate } from './startup/serve-desktop-activation'
import { RateLimitService } from './rate-limits/service'
import { readMiniMaxSessionCookie } from './minimax/minimax-cookie-store'
import { getInitialClaudeRateLimitTarget } from './rate-limits/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './rate-limits/codex-rate-limit-target'
import { createAccountRuntimeTargetSettingsSync } from './rate-limits/account-runtime-target-sync'
import {
  attachMainWindowServices,
  ensureAutoUpdaterConfigured
} from './window/attach-main-window-services'
import { createMainWindow, loadMainWindow } from './window/createMainWindow'
import { zoomDashboardPopoutIfFocused } from './window/dashboard-popout-window'
import {
  createSystemTray,
  destroySystemTray,
  setMacMenuBarIconVisible,
  setTrayAttention,
  type SystemTrayOptions
} from './tray/system-tray'
import { focusExistingMainWindow } from './window/focus-existing-window'
import { notifyMainWindowBecameVisible } from './window/main-window-visibility'
import { CodexAccountService } from './codex-accounts/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import { markCodexProjectTrusted } from './agent-trust-presets'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from './claude-accounts/runtime-selection'
import { codexHookService, setSystemCodexHomeHookSweepSuppressed } from './codex/hook-service'
import {
  ensureRealHomeCodexHookState,
  isRealHomeCodexHookLaneUsable
} from './codex/codex-real-home-hook-install'
import { setCodexTrustGrantTelemetry } from './codex/codex-hook-trust-grant'
import { startCodexSessionBackfillInBackground } from './codex/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from './codex/codex-session-index-heal'
import { createCodexSessionMigrationScheduler } from './codex/codex-session-migration-scheduler'
import { prepareLegacySharedCodexSessionResume } from './codex/codex-legacy-session-resume'
import { resolveHostCodexSessionSourceHome } from './codex/codex-session-source-home'
import { findTrustedCodexSessionResume } from './codex/codex-session-resume-home'
import { getSystemCodexHomePath } from './codex/codex-home-paths'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import type { AgentProviderSessionMetadata } from '../shared/agent-session-resume'
import { getDefaultWslDistro } from './wsl'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import {
  attachClaudeLivePtyPersistence,
  seedLiveClaudePtysFromPersistence
} from './claude-accounts/live-pty-gate'
import { StarNagService } from './star-nag/service'
import { agentHookServer } from './agent-hooks/server'
import { wslHookRelayManager } from './agent-hooks/wsl-hook-relay-manager'
import { maybeAutoRenameBranchOnFirstWork } from './agent-hooks/first-work-branch-rename'
import { rememberBranchRenameFailureOutput } from './agent-hooks/branch-rename-failure-output'
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
  getSshPtyProvider,
  registerHeadlessPtyRuntime
} from './ipc/pty'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { EmulatorBridge } from './emulator/emulator-bridge'
import { browserCertificateTrustController, browserManager } from './browser/browser-manager'
import { OffscreenBrowserBackend } from './browser/offscreen-browser-backend'
import { initializeBrowserSessionsForApp } from './browser/browser-session-startup'
import { setUnreadDockBadgeCount } from './dock/unread-badge'
import { AutomationService } from './automations/service'
import { createHeadlessAutomationOutputSnapshotBuffer } from './automations/headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from './automations/headless-workspace-create'
import { AgentAwakeService } from './agent-awake-service'
import { registerSystemResumeBroadcast } from './system-resume-broadcast'
import {
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { getMainProcessLifecycleIdentity } from './crash-reporting/main-process-lifecycle-identity'
import { CrashReportStore } from './crash-reporting/crash-report-store'
import {
  shouldRecoverRendererAfterProcessGone,
  type ExpectedTeardownScope
} from './crash-reporting/process-gone-classification'
import { recordProcessGoneCrash as recordProcessGoneCrashEvent } from './crash-reporting/process-gone-recorder'
import {
  advanceSyntheticTitleSpinnerEntries,
  type SyntheticTitleSpinnerEntry
} from './synthetic-title-spinner'
import { shouldSendSyntheticTitleFrame } from './synthetic-title-visibility'
import { shouldCopySyntheticTitleFrameToPtyData } from './synthetic-title-frame-routing'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  type SyntheticAgentTitleProfile
} from '../shared/synthetic-agent-title'
import type { AgentStatusState } from '../shared/agent-status-types'
import { resolveTuiAgentPermissionMode } from '../shared/tui-agent-permissions'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeDesktopWindowStatus
} from '../shared/runtime-types'
import { LocalPtyProvider } from './providers/local-pty-provider'
import { KeybindingService } from './keybindings/keybinding-service'
import { applyElectronProxySettings } from './network/proxy-settings'
import { preserveAgentAuthBeforeRestart } from './agent-auth-restart-preservation'
import { CliInstaller } from './cli/cli-installer'
import { installLinuxBareOrcaDispatcher } from './cli/linux-bare-orca-dispatcher'
import { reconcileManagedWslCliRegistrations } from './cli/wsl-cli-registration-reconciliation'
import { selfHealRuntimeEnvironmentFocus } from './runtime-environment-focus-self-heal'

let mainWindow: BrowserWindow | null = null
/** Whether a manual app.quit() (Cmd+Q) is in progress; lets the close handler skip the running-process confirmation and go straight to close. */
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
const serveReadinessPublisher = new ServeReadinessPublisher()
let desktopRelayService: DesktopRelayService | null = null
let desktopRelayStatus: RelayBrokerStatus = 'offline'
// Why: gates whether headless serve installs the offscreen browser backend (and advertises browser pane support).
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
// Why: a reload intent must not leak to a later load; the recovery reload re-fires did-finish-load, so its flag spares live PTYs from the orphan sweep (#5787).
const expectedRendererReload = createWebContentsTimedFlag()
const recoveryReloadInFlight = createWebContentsTimedFlag()
// Why: a tray "Settings…" click can precede the renderer's ui:openSettings listener; it pulls this one-shot on mount.
const pendingOpenSettings = createWebContentsTimedFlag()
let firstWindowStartupServicesReady: Promise<void> = Promise.resolve()
let managedWslCliReconciliationReady: Promise<void> = Promise.resolve()
let managedWslCliStartupBarrierReady: Promise<void> = Promise.resolve()
// Why: the serve barrier fails open, so this state tells headless clients a WSL PTY launch may still race an un-migrated registration ('settled' = off-Windows no-op).
let managedWslCliReconciliationStatus: 'pending' | 'settled' | 'failed' = 'settled'
// Why: GPU child crashes clustered right after launch indicate a broken driver; track them to switch this build to software rendering.
const gpuLaunchTimeMs = Date.now()
const gpuCrashFallbackTracker = new GpuCrashFallbackTracker({
  windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
})
let gpuFallbackActiveThisLaunch = false
let localPtyStartupReady: Promise<void> = Promise.resolve()
let localPtyProviderStartupReady: Promise<void> = Promise.resolve()
const AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS = 30_000
const isServeMode = process.argv.includes('--serve')
if (isServeMode) {
  reserveServeStdoutForReadiness()
}
const desktopActivationGate = createServeDesktopActivationGate({
  initialState: isServeMode ? 'initializing' : 'ready',
  activateWindow: () => {
    // Why: an updater replacement must not resurrect the old app bundle.
    if (!isQuittingForUpdate()) {
      focusExistingWindow()
    }
  },
  onBlocked: (reason) => console.error(`[serve] Desktop activation blocked: ${reason}`)
})
// Why: on Windows a CLI launch that lost ELECTRON_RUN_AS_NODE would boot the GUI and exit silently; redirect to node mode before the lock gate below.
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

// Kill switch for the first-work on-disk folder rename; the renderer reconciles the id change (migrateWorktreeIdentity) so it isn't mistaken for a deletion.
const ENABLE_FIRST_WORK_FOLDER_RENAME = false

// Why: inject the index.ts store/runtime singletons so the rename orchestrator stays module-state-free and unit-testable.
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
        // Why: a user branch could coincidentally match a creature name; only Orca-stamped worktrees are safe to auto-rename.
        return !!meta?.orcaCreationSource && meta.preserveBranchOnDelete !== true
      },
      setDisplayName: (worktreeId, displayName) => {
        rememberBranchRenameFailureOutput(worktreeId, null)
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
          // Success clears the failure badge (redundant with the explicit setRenameError(null)).
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
      setRenameError: (worktreeId, error, failureOutput) => {
        // Refresh the full-output capture before the dedupe below — a repeat error string is still a fresh run.
        rememberBranchRenameFailureOutput(worktreeId, error === null ? null : failureOutput)
        // Skip the write + push when unchanged — most settled worktrees never had an error to clear.
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
        // Why: the hook only knows the worktreeId, so derive the repoId notifyBranchRenamed expects.
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
// Why: expose the app version via process.env so main and the forked daemon can set TERM_PROGRAM_VERSION without importing electron.
process.env.ORCA_APP_VERSION = app.getVersion()
patchPackagedProcessPath()
// Why: the sync seed above covers early IPC (homebrew/nix); the async login-shell probe below (packaged only) then adds the user's rc PATH.
if (app.isPackaged && process.platform !== 'win32') {
  void hydrateShellPath().then((result) => {
    if (result.ok) {
      mergePathSegments(result.segments)
    }
  })
}
configureDevUserDataPath(is.dev)
configureOrcaUserDataPathEnv()
installServeSupervisorDisconnectQuit(isServeMode)

// Why: just past createMainWindow's 10s ready-to-show fallback, so a window revealed that way still gets its tray icon.
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
// Self-gated on ORCA_MAIN_THREAD_DIAGNOSTICS; runs the whole session to catch steady-state churn (issue #7576).
startMainThreadChurnProbe()

function focusExistingWindow(): void {
  focusExistingMainWindow({
    app,
    getWindow: () => mainWindow,
    openWindow: openMainWindow,
    warn: console.warn
  })
}

function requestDesktopActivation(): void {
  desktopActivationGate.requestActivation()
}

function getDesktopWindowStatus(): RuntimeDesktopWindowStatus {
  const state = desktopActivationGate.getState()
  return state === 'ready' ? 'openable' : state
}

function settleServeDesktopActivation(): void {
  if (getLocalPtyProvider() instanceof LocalPtyProvider) {
    desktopActivationGate.markBlocked('persistent PTY provider unavailable')
    return
  }
  desktopActivationGate.markReady()
}

// Why: webContents-scoped auto-expiring flag so an intent can't leak to a later renderer load; `consume` clears on match for one-shot signals.
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
  // Why: consume on read — the recovery reload fires exactly one did-finish-load, so a later genuine reload still sweeps orphaned PTYs.
  return recoveryReloadInFlight.matches(webContentsId, { consume: true })
}

function recordAgentStateCrashBreadcrumb(agentType: string, state: string): void {
  // Why: hook pings arrive many times/sec; coalesce so identical state pings don't fill all 30 breadcrumbs, leaving room for renderer errors.
  recordCoalescedCrashBreadcrumb({
    name: 'agent_state_changed',
    data: { agentType, state },
    coalesceKey: `agent:${agentType}:${state}`,
    minIntervalMs: AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS
  })
}

// Why: acquire AFTER configureDevUserDataPath — Electron derives lock identity from `userData`, so dev/packaged lock in separate namespaces.
// Why skip in dev: parallel `pnpm dev` from multiple worktrees would make the second exit silently; packaged keeps the lock (corruption PR #1326 / #1312).
const bypassSingleInstanceLock = shouldBypassSingleInstanceLock({
  isDev: is.dev,
  isServeMode
})
const skipSingleInstanceLock = shouldSkipSingleInstanceLock({
  isDev: is.dev,
  isServeMode
})
if (bypassSingleInstanceLock) {
  // Why: diagnostic escape hatch for macOS builds where Electron reports a false lock loss before any app logs exist.
  logSingleInstanceLockBypass()
}
const hasSingleInstanceLock = skipSingleInstanceLock
  ? true
  : bypassSingleInstanceLock
    ? true
    : acquireSingleInstanceLock(app, requestDesktopActivation)
if (startupDiagnosticsEnabled) {
  logStartupDiagnostic('single-instance-lock-result', {
    acquired: hasSingleInstanceLock,
    bypassed: bypassSingleInstanceLock,
    skippedForDev: skipSingleInstanceLock
  })
}
if (!hasSingleInstanceLock) {
  // Why: a false-negative lock loss otherwise looks like a silent crash on packaged macOS; `open --stderr` can capture this line.
  logSingleInstanceLockFailure()
  app.quit()
}

// Why: when another process holds the lock we've already quit; skip file-writing side effects so this transient process never touches userData.
if (hasSingleInstanceLock) {
  // Why: couple to dev-parent only for electron-vite desktop runs; `orca serve`'s parent (CLI shim/background shell) isn't the intended server lifetime.
  const shouldCoupleToDevParent = is.dev && !isServeMode
  installDevParentDisconnectQuit(shouldCoupleToDevParent)
  installDevParentWatchdog(shouldCoupleToDevParent)
  installDevParentSignalQuit(shouldCoupleToDevParent)
  // Why: run after configureDevUserDataPath but before app.setName('Orca') (whenReady), which changes the resolved path on case-sensitive filesystems.
  initDataPath()
  // Why: use the canonical userData path — late app.getPath('userData') can resolve differently across restarts, defeating persistence.
  initSessionParseCachePersistence({
    filePath: join(getCanonicalUserDataPath(), 'ai-vault', 'session-parse-cache.json'),
    appVersion: app.getVersion()
  })
  initOrcaProfilePaths()
  // Why: same timing as initDataPath — capture userData before app.setName changes it. See persistence.ts:20-28.
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  crashReports = CrashReportStore.fromUserData()
  recordCrashBreadcrumb('app_started', {
    packaged: app.isPackaged,
    platform: process.platform,
    ...getMainProcessLifecycleIdentity()
  })
  configureElectronNetworkCompatibility()
  enableRendererHeapHeadroom()
  maybeApplyGpuFallbackForThisLaunch()
  if (!gpuFallbackActiveThisLaunch) {
    enableMainProcessGpuFeatures()
  }
  // Why: headless serve's offscreen BrowserWindows need an X display (Xvfb) on Linux; the result gates whether the offscreen backend is installed.
  headlessBrowserDisplayAvailable = ensureVirtualDisplayForHeadlessServe({ isServeMode })
}

ipcMain.handle('app:awaitFirstWindowStartupServices', async () => {
  // Why: restored WSL terminals get a bounded chance to receive launcher repairs before window rendering proceeds.
  await Promise.all([firstWindowStartupServicesReady, managedWslCliStartupBarrierReady])
})

// Why: the renderer pulls this once its ui:openSettings listener attaches, so a Settings request queued before mount isn't lost.
ipcMain.handle('ui:consumePendingOpenSettings', (event) =>
  pendingOpenSettings.matches(event.sender.id, { consume: true })
)

ipcMain.handle(
  'app:startupDiagnostic',
  (_event, event: string, details?: Record<string, unknown>) => {
    if (!startupDiagnosticsEnabled || !event.startsWith('renderer-')) {
      return
    }
    logStartupMilestone(event, details && typeof details === 'object' ? details : {})
  }
)

function startTerminalRuntimeStartupServices(): Promise<void> {
  logStartupMilestone('first-window-startup-services-start')
  const startupServices = startFirstWindowStartupServices({
    // Why: both desktop and headless serve must adopt the same persistent provider before creating terminals or a renderer.
    startDaemonPtyProvider: async (signal) => {
      logStartupMilestone('startup-service-start', { service: 'daemon-pty-provider' })
      await initDaemonPtyProvider(signal)
      logStartupMilestone('startup-service-done', { service: 'daemon-pty-provider' })
    },
    // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from live server state, so the renderer awaits this before restored terminals reconnect.
    startAgentHookServer: async () => {
      if (!isAgentStatusHooksEnabled(store?.getSettings())) {
        return
      }
      logStartupMilestone('startup-service-start', { service: 'agent-hook-server' })
      await agentHookServer.start({
        env: app.isPackaged ? 'production' : 'development',
        // Why: hooks source this endpoint file at invocation time so old PTY env reaches the current process after restart; dev namespaces it (worktrees share `orca-dev`).
        userDataPath: app.getPath('userData'),
        endpointNamespace: devAgentHookEndpointNamespace
      })
      logStartupMilestone('startup-service-done', { service: 'agent-hook-server' })
    },
    onDaemonError: (error) => {
      // Why: daemon failure silently falls back to non-persistent local PTYs; log + telemetry so a fleet-wide outage is observable (was invisible in v1.4.129-rc.1).
      const reason = error instanceof Error ? error.message : String(error)
      console.error(
        `[daemon] STARTUP FAILED — falling back to local PTYs; terminals will not persist across quit. Reason: ${reason}`
      )
      track('daemon_start_failed', classifyError(error))
    },
    onAgentHookServerError: (error) => {
      // Why: hook callbacks are sidebar enrichment only; Orca must still boot if the loopback receiver fails.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })
  firstWindowStartupServicesReady = startupServices.firstWindowReady
  localPtyStartupReady = startupServices.localPtyReady
  localPtyProviderStartupReady = startupServices.localPtyProviderReady
  void firstWindowStartupServicesReady.then(() => {
    logStartupMilestone('first-window-startup-services-ready')
  })
  void localPtyStartupReady.then(() => {
    logStartupMilestone('local-pty-startup-ready')
  })
  return firstWindowStartupServicesReady
}

function prepareCodexRuntimeHomeForLaunch(
  target?: CodexAccountSelectionTarget,
  launchEnv?: NodeJS.ProcessEnv,
  launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
): string | null {
  if (
    target?.runtime !== 'wsl' &&
    launchContext?.launchAgent === 'codex' &&
    launchContext.workspacePath
  ) {
    try {
      // Why: renderer quick-launch cannot await trust IPC before its PTY mounts; launch prep runs synchronously before every recognized Codex spawn.
      markCodexProjectTrusted(launchContext.workspacePath)
    } catch (error) {
      console.warn('[codex-project-trust] failed to pre-mark launch workspace:', error)
    }
  }
  const ensureRealHomeHooksIfSelected = (): boolean => {
    if (
      target?.runtime === 'wsl' ||
      !codexRuntimeHome!.isHostSystemDefaultRealHomeSelected(launchEnv)
    ) {
      return false
    }
    // Why (flag ON, system default): the hook entry must exist — appended last
    // and trusted by codex's own app-server grant — in the real ~/.codex before
    // the pane spawns. An incapable grant flips the lane gate so the launch
    // below falls back to the managed home instead of a status-blind pane.
    ensureRealHomeCodexHookState({
      hooksEnabled: isAgentStatusHooksEnabled(store?.getSettings()),
      userDataPath: app.getPath('userData')
    })
    return true
  }
  let realHomeHooksPrepared = ensureRealHomeHooksIfSelected()
  let runtimeHomePath = codexRuntimeHome!.prepareForCodexLaunch(target, launchEnv)
  if (runtimeHomePath === null && !realHomeHooksPrepared) {
    // Why: a managed home can lose auth during launch prep, which clears its
    // selection and falls through to real home. Establish hook capability for
    // that newly selected lane, then re-resolve if the capability gate rejects it.
    realHomeHooksPrepared = ensureRealHomeHooksIfSelected()
    if (realHomeHooksPrepared) {
      runtimeHomePath = codexRuntimeHome!.prepareForCodexLaunch(target, launchEnv)
    }
  }
  if (runtimeHomePath === null && target?.runtime !== 'wsl') {
    // Why: Codex runs on the user's real ~/.codex; the managed-home hook
    // install below would target a home Codex never reads on this lane.
    return null
  }
  const hookTarget =
    target?.runtime === 'wsl'
      ? {
          runtime: 'wsl' as const,
          wslDistro: target.wslDistro?.trim() || getDefaultWslDistro()
        }
      : target
  const hooksEnabled = isAgentStatusHooksEnabled(store?.getSettings())
  try {
    // Why: honor the persisted off switch so post-startup launches can't reinstall removed hooks.
    const status = hooksEnabled
      ? (codexHookService.installForRuntimeHome(runtimeHomePath, hookTarget) ??
        // Why: a managed account's launch home is its own self-contained
        // CODEX_HOME, so hooks/trust must install there, not the shared mirror.
        codexHookService.install(runtimeHomePath ?? undefined))
      : (codexHookService.refreshRuntimeUserHooksForRuntimeHome(runtimeHomePath, hookTarget) ??
        codexHookService.refreshRuntimeUserHooks(runtimeHomePath ?? undefined))
    if (status.state === 'error') {
      console.warn(
        `[codex-hook-service] failed to ${
          hooksEnabled ? 'refresh' : 'refresh user'
        } runtime hooks before launch`,
        status.detail
      )
    }
  } catch (error) {
    // Why: hook install is best-effort launch prep; a malformed hooks file must not block Codex from starting.
    console.warn(
      `[codex-hook-service] failed to ${
        hooksEnabled ? 'refresh' : 'refresh user'
      } runtime hooks before launch`,
      error
    )
  }
  return runtimeHomePath
}

async function prepareCodexSessionResumeForLaunch(args: {
  providerSession: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  workspacePath?: string
}): Promise<{ codexHomePath: string | null } | null> {
  if (args.target.runtime === 'wsl' || !codexRuntimeHome || !store) {
    return null
  }
  const systemHomePath = getSystemCodexHomePath()
  // Why: codexSessionSourceHome is import-only; treating it as CODEX_HOME would mutate history sources and bypass account auth.
  const trustedHomes = [
    systemHomePath,
    ...codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery()
  ]
  const sessionSource = await findTrustedCodexSessionResume({
    sessionId: args.providerSession.id,
    transcriptPath: args.providerSession.transcriptPath,
    trustedCodexHomes: trustedHomes
  })
  if (!sessionSource) {
    if (args.providerSession.transcriptPath) {
      throw new Error(
        'Orca could not verify the originating Codex session file, so automatic resume was stopped to avoid using a different account.'
      )
    }
    return null
  }

  let migrated = { useRealCodexHome: false }
  try {
    migrated = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        executionHostId: 'local',
        filePath: sessionSource.transcriptPath,
        codexHome: sessionSource.homePath
      },
      {
        isHostSystemDefaultRealHome: () => codexRuntimeHome!.isHostSystemDefaultRealHome(),
        systemCodexHomePath: systemHomePath
      }
    )
  } catch (error) {
    // Why: migration is a compatibility repair; its failure must not prevent the PTY from resuming from its trusted origin home.
    console.warn(
      '[codex-session-resume] Legacy rollout migration failed; using origin home:',
      error
    )
  }
  const resumeHome = migrated.useRealCodexHome ? systemHomePath : sessionSource.homePath

  if (args.workspacePath) {
    try {
      markCodexProjectTrusted(args.workspacePath)
    } catch (error) {
      console.warn('[codex-project-trust] failed to pre-mark resumed workspace:', error)
    }
  }
  const isSystemHome =
    normalizeRuntimePathForComparison(resumeHome) ===
    normalizeRuntimePathForComparison(systemHomePath)
  const hooksEnabled = isAgentStatusHooksEnabled(store.getSettings())
  try {
    if (isSystemHome) {
      ensureRealHomeCodexHookState({ hooksEnabled, userDataPath: app.getPath('userData') })
    } else if (hooksEnabled) {
      codexHookService.install(resumeHome)
    } else {
      codexHookService.refreshRuntimeUserHooks(resumeHome)
    }
  } catch (error) {
    // Why: hook repair is best-effort; session provenance must still win over the currently selected home.
    console.warn('[codex-hook-service] failed to prepare automatic resume home:', error)
  }
  return { codexHomePath: resumeHome }
}

// Why: restore the window the close handler may have hidden to tray, or reopen it (dock-reactivation style) if fully torn down.
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

function openSettingsFromSystemMenu(): void {
  showMainWindowFromTray()
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!targetWindow) {
    return
  }
  recordCrashBreadcrumb('settings_opened')

  // Why: no signal proves the renderer listener is attached — push, and also leave a one-shot intent the unmounted renderer pulls at mount.
  targetWindow.webContents.send('ui:openSettings')
  // Why: untimed — any TTL can be outrun by a slow cold start; id-scoping + consume-on-read still prevent leaking to a later renderer.
  pendingOpenSettings.mark(targetWindow.webContents.id, Number.POSITIVE_INFINITY)
}

function quitFromSystemTray(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Why: a hidden session may veto shutdown with a save/discard prompt, so make the window visible.
    showMainWindowFromTray()
  }
  // Why: set the quit latch before app.quit() so the 'close' handler tears down instead of re-hiding to tray.
  isQuitting = true
  app.quit()
}

// Why: menu/tray are clickable before anything else configures the updater.
function runUserInitiatedUpdateCheck(options?: UpdateCheckOptions): void {
  ensureAutoUpdaterConfigured()
  checkForUpdatesFromMenu(options)
}

function getSystemTrayOptions(): SystemTrayOptions | null {
  if (!store) {
    return null
  }
  return {
    appIcon: store.getSettings().appIcon,
    isDevInstance: devInstanceIdentity.isDev,
    devInstanceLabel: devInstanceIdentity.devLabel,
    onOpen: showMainWindowFromTray,
    onOpenSettings: openSettingsFromSystemMenu,
    onCheckForUpdates: () => {
      // Why: updater status renders in the main window, so a bare check would complete invisibly.
      showMainWindowFromTray()
      runUserInitiatedUpdateCheck()
    },
    onQuit: quitFromSystemTray
  }
}

function syncMacMenuBarIcon(showMenuBarIcon: boolean): Tray | null {
  if (process.platform !== 'darwin' || isServeMode) {
    return null
  }
  const options = getSystemTrayOptions()
  return options ? setMacMenuBarIconVisible(showMenuBarIcon, options) : null
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

  // Why: Chromium's BrowserWindow ctor resets userData to a Protected DACL, breaking writes; re-grant ACEs (marker-gated to avoid a ~60s startup stall).
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
    shouldRecoverRenderer: (details, webContentsId) =>
      shouldRecoverRendererAfterProcessGone({
        reason: details.reason,
        expectedTeardown: getExpectedTeardownScope(webContentsId)
      }),
    onRendererRecoveryExhausted: ({ details, recentRecoveryCount }) => {
      recordDurableCrashBreadcrumb('renderer_recovery_circuit_breaker_open', {
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
    // Why: the recovery reload re-fires did-finish-load; flag it so the local-PTY orphan sweep skips that reload (#5787).
    onBeforeRecoveryReload: (webContentsId) => {
      markRecoveryReloadInFlight(webContentsId)
      recordDurableCrashBreadcrumb('renderer_recovery_reload')
    }
  })
  recordCrashBreadcrumb('main_window_created')
  logStartupMilestone('window-created')
  // Why: Windows Tray construction can block synchronously on Shell_NotifyIcon, so both platforms defer creation to after first paint.
  let trayCreated = false
  const createSystemTrayDeferred = (): void => {
    if (trayCreated || window.isDestroyed() || isQuitting || !store) {
      return
    }
    trayCreated = true
    if (process.platform === 'darwin') {
      // Why: route through syncMacMenuBarIcon so startup and the live toggle share one serve-mode/visibility policy.
      if (syncMacMenuBarIcon(store.getSettings().showMenuBarIcon !== false)) {
        logStartupMilestone('tray-created')
      }
      return
    }
    const options = getSystemTrayOptions()
    if (options && createSystemTray(options)) {
      logStartupMilestone('tray-created')
    }
  }
  window.once('ready-to-show', () => {
    logStartupMilestone('ready-to-show')
    setImmediate(createSystemTrayDeferred)
  })
  const trayCreateFallback = setTimeout(createSystemTrayDeferred, TRAY_CREATE_FALLBACK_MS)
  trayCreateFallback.unref?.()

  // Why: telemetry-plan.md anchors default-on app_opened to the first main-window load; this path fires only once consent is already enabled.
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
        codexRuntimeHome ? codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery() : [],
      prepareAiVaultSessionResume: (args) =>
        prepareLegacySharedCodexSessionResume(args, {
          isHostSystemDefaultRealHome: () =>
            codexRuntimeHome?.isHostSystemDefaultRealHome() === true,
          systemCodexHomePath: resolveHostCodexSessionSourceHome(store!.getSettings())
        }),
      onBeforeRelaunch: async () => {
        isQuitting = true
        desktopRelayService?.fenceAndCloseNow()
        await preserveAgentAuthBeforeRestart({ codexRuntimeHome, claudeRuntimeAuth, store })
      },
      onOrcaProfileAuthMutation: () => desktopRelayService?.authMutated(),
      onBeforeOrcaProfileSignOut: () => desktopRelayService?.fenceAndCloseNow()
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
      prepareCodexSessionResume: prepareCodexSessionResumeForLaunch,
      awaitLocalPtyStartup: () => localPtyStartupReady,
      awaitLocalPtyProviderStartup: () => localPtyProviderStartupReady,
      onBeforeRendererReload: ({ ignoreCache, webContentsId }) => {
        if (window.webContents.id === webContentsId) {
          markExpectedRendererReload(webContentsId)
        }
        recordCrashBreadcrumb('renderer_reload_requested', { ignoreCache })
      },
      // Why: let the PTY layer skip its orphan sweep on the recovery reload that re-fires did-finish-load, so live local sessions survive (#5787).
      isRecoveryReloadInFlight,
      onBeforeUpdateQuit: () =>
        preserveAgentAuthBeforeRestart({ codexRuntimeHome, claudeRuntimeAuth, store }),
      updateInstallMode: resolveUpdateInstallMode(isServeMode)
    }
  )
  rateLimits.attach(window)
  // Why: quota probes spawn CLIs and hit network, so don't fetch immediately and compete with first paint; show/focus listeners refresh later.
  rateLimits.start({ fetchImmediately: false })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
    clearExpectedRendererReload(rendererWebContentsId)
    automations?.setWebContents(null)
    // Why: detach the hook listener on close so the server never fires into destroyed webContents before reopen, and replay runs only on deliberate recreations.
    agentHookServer.setListener(null)
    agentHookServer.setPaneStatusClearListener(null)
    setMigrationUnsupportedPtyListener(null)
    // Why: stop the spinner timer here — it would fire into destroyed webContents, and per-pane teardown may never run for restored-but-untorn panes.
    stopAllSyntheticTitleSpinners()
  })
  mainWindow = window
  window.on('show', resumeSyntheticTitleSpinnerTimer)
  window.on('restore', resumeSyntheticTitleSpinnerTimer)
  window.on('hide', stopSyntheticTitleSpinnerTimer)
  window.on('minimize', stopSyntheticTitleSpinnerTimer)
  // Why: visibility-gated pollers (SSH port scanner) park while hidden and resume on this signal; re-wired per window since dock re-activation recreates it.
  window.on('show', notifyMainWindowBecameVisible)
  window.on('restore', notifyMainWindowBecameVisible)
  // Why: user is back on show/restore, so clear the tray attention dot set while hidden (see notifications.ts).
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
      providerSessionOnly,
      promptInteractionKey,
      isReplay
    }) => {
      if (mainWindow?.isDestroyed()) {
        return
      }
      if (providerSessionOnly) {
        // Why: session_start just refreshes durable resume identity while Pi is idle; forward it without titles, telemetry, or status UI.
        mainWindow?.webContents.send('agentStatus:set', {
          ...payload,
          paneKey,
          ...(launchToken ? { launchToken } : {}),
          tabId,
          worktreeId,
          connectionId,
          receivedAt,
          stateStartedAt,
          ...(providerSession ? { providerSession } : {}),
          providerSessionOnly: true
        })
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
        ...(promptInteractionKey ? { promptInteractionKey } : {}),
        ...(orchestration ? { orchestration } : {})
      })
      recordAgentStateCrashBreadcrumb(payload.agentType ?? 'unknown', payload.state)
      // Why: native OSC titles miss some idle/permission frames, so inject hook-derived ones to keep the renderer title tracker in sync.
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
  agentHookServer.setPaneStatusClearListener((clear) => {
    if (mainWindow?.isDestroyed()) {
      return
    }
    mainWindow?.webContents.send('agentStatus:clear', clear)
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

// Why: on renderer crash-loop the breaker stops auto-reloading and the window goes blank, so a main-process dialog is the only retry/quit surface.
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
    recordDurableCrashBreadcrumb('renderer_recovery_manual_retry')
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

// Why: read the GPU-fallback marker before app.whenReady() so app.disableHardwareAcceleration() takes effect. Windows desktop only.
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

// Why: a burst of GPU child crashes right after launch means HW acceleration is unusable — persist a build-scoped marker and relaunch into software rendering.
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
  relaunchApp('gpu-fallback', {
    processReason: reason,
    exitCode,
    crashesInWindow: result.crashesInWindow
  })
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
  recordProcessGoneCrashEvent(crashReports, {
    source,
    processType,
    reason,
    exitCode,
    expectedTeardown: getExpectedTeardownScope(webContentsId),
    details
  })
}

function shutdownWatchersOnce(): Promise<void> {
  if (watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Why: @parcel/watcher tears down native async work on unsubscribe; Electron must await it before Node's environment exits.
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

// Why: cursor-agent re-emits its own OSC title on every redraw, overwriting a one-shot frame — so re-assert a working frame on an interval.
// 80ms matches Pi's cadence (smooth but under the IPC budget). opencode needs only one frame but reuses this for consistent animated UX.
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
  const appPath = app.getAppPath()
  const roots = [
    join(appPath, 'out', 'web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the web bundle.
    join(appPath, '..', 'web')
  ]
  return roots.find((root) => existsSync(join(root, 'web-index.html')))
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
  const boundEndpoint = runtimeRpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const pairing = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : runtimeRpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: options.mobilePairing ? 'mobile' : 'runtime'
      })
  const pairingQr =
    pairing.available && options.mobilePairing
      ? await renderTerminalPairingQr(pairing.pairingUrl)
      : null
  await serveReadinessPublisher.publish(
    {
      runtimeId: runtime.getRuntimeId(),
      boundEndpoint,
      advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
      // Why: the WSL reconciliation barrier fails open, so 'pending' warns a WSL PTY launch may still race a repair.
      managedWslCliReconciliation: managedWslCliReconciliationStatus,
      pairing: pairing.available
        ? {
            available: true,
            url: pairing.pairingUrl,
            endpoint: pairing.endpoint,
            deviceId: pairing.deviceId,
            webClientUrl: pairing.webClientUrl,
            scope: options.mobilePairing ? 'mobile' : 'runtime',
            qr: pairingQr
          }
        : pairing
    },
    options.recipeJson
      ? { mode: 'recipe-json', projectRoot: options.projectRoot! }
      : { mode: options.json ? 'json' : 'human' }
  )
  notifyServeSupervisorReady(runtime.getRuntimeId())
}

function installServeSignalHandlers(): void {
  const quit = (): void => {
    // Why: route SIGINT/SIGTERM through Electron's normal quit so runtime metadata, daemon checkpoints, and telemetry flush.
    app.quit()
  }
  process.once('SIGINT', quit)
  process.once('SIGTERM', quit)
}

// Why: on PTY teardown drop the spinner entry explicitly, else the shared timer keeps ticking with sendSyntheticTitle no-oping forever.
registerPaneKeyTeardownListener((paneKey) => {
  stopSyntheticTitleSpinner(paneKey)
})

function sendSyntheticTitle(ptyId: string, data: string, options: { force?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  // Why: throttle decorative spinner frames (up to 80ms/agent); final/permission frames are forced because they drive BEL.
  if (
    !shouldSendSyntheticTitleFrame({
      force: options.force === true,
      windowVisible: isSyntheticTitleWindowVisible()
    })
  ) {
    return
  }
  // Why: feed the per-PTY tracker directly, never onPtyData — emulator/tails/transcripts/stats must not see fabricated bytes.
  runtime?.ingestSyntheticTitleFrame(ptyId, data)
  // Why: only the kill-switch-off renderer byte-parses synthetic frames; under main authority the copy mints phantom ACKs (see synthetic-title-frame-routing.ts).
  if (shouldCopySyntheticTitleFrameToPtyData(store?.getSettings())) {
    mainWindow.webContents.send('pty:data', { id: ptyId, data })
  }
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
  // Why: one shared timer for all spinners — per-pane intervals multiplied idle wakeups when several agents were working.
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
    // Why: emit the first frame immediately so the spinner is visible now, not up to 80ms later at the next interval tick.
    const existing = syntheticTitleSpinnerByPaneKey.get(paneKey)
    const frame = existing ? existing.frame : 0
    sendSyntheticTitle(ptyId, `\x1b]0;${SPINNER_FRAMES[frame]} ${profile.workingLabel}\x07`)
    if (existing) {
      // Why: refresh the profile so a mid-pane agent-type change lands on the right idle/permission labels at terminal state.
      existing.profile = profile
      return
    }
    syntheticTitleSpinnerByPaneKey.set(paneKey, { frame, profile })
    ensureSyntheticTitleSpinnerTimer()
    return
  }
  // Why: stop the spinner first so the next tick can't race the state back to "working", then inject the terminal frame.
  // Permission frames add a trailing BEL to light up user-input states; done frames omit it (completion notifications own that attention).
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
  // Why: install certificate decisions before any webview or headless window issues its first TLS request.
  app.on(
    'certificate-error',
    (event, webContents, url, error, certificate, callback, isMainFrame) => {
      browserCertificateTrustController.handleCertificateError({
        event,
        webContents,
        url,
        error,
        certificate,
        callback,
        isMainFrame
      })
    }
  )
  electronApp.setAppUserModelId(devInstanceIdentity.appUserModelId)
  // Why: setName drives the macOS safeStorage Keychain item name; use the stable appName (not per-branch `name`) so dev branches share one key and don't re-prompt.
  app.setName(devInstanceIdentity.appName)

  // Why: managed WSL launchers live outside the Windows app bundle, so keep their launcher/bridge contract synced across app updates.
  managedWslCliReconciliationStatus = 'pending'
  managedWslCliReconciliationReady = reconcileManagedWslCliRegistrations({
    isPackaged: app.isPackaged,
    userDataPath: getCanonicalUserDataPath(),
    appVersion: app.getVersion()
  })
    .then((results) => {
      for (const result of results) {
        if (result.outcome === 'failed') {
          console.warn(
            `[wsl-cli] ${result.distro} managed registration reconciliation failed: ${result.error}`
          )
        } else if (result.outcome === 'repaired') {
          console.log(`[wsl-cli] Repaired managed registration in ${result.distro}.`)
        }
      }
      managedWslCliReconciliationStatus = 'settled'
    })
    .catch((error) => {
      managedWslCliReconciliationStatus = 'failed'
      console.warn(
        '[wsl-cli] Managed registration reconciliation discovery failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
  managedWslCliStartupBarrierReady = createWslCliReconciliationStartupBarrier(
    managedWslCliReconciliationReady
  )

  const activeOrcaProfile = ensureActiveOrcaProfile()
  store = new Store({ dataFile: activeOrcaProfile.dataFile })
  logStartupMilestone('store-loaded')
  store.onSettingsChanged((updates, settings) => {
    if ('showMenuBarIcon' in updates) {
      // Why: Store is the mutation authority for all settings writes, so every macOS toggle updates the native item live.
      syncMacMenuBarIcon(settings.showMenuBarIcon !== false)
    }
  })
  // Why: run before ClaudeRuntimeAuthService's constructor sync — a surviving daemon Claude CLI holds the single-use refresh token; early refresh rotates it out mid-session.
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
    // Why: Dock/Launchpad launches don't inherit shell proxy env vars, so apply the persisted proxy before any app-owned network fetchers run.
    await applyElectronProxySettings(store.getSettings())
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings')
  }
  // Why: browser sessions serve desktop webviews and runtime profile commands, so init at app startup rather than via a renderer IPC path.
  initializeBrowserSessionsForApp({
    orcaProfileId: activeOrcaProfile.profile.id,
    profileDirectory: activeOrcaProfile.profileDirectory
  })
  unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  agentAwakeService = new AgentAwakeService()
  agentAwakeService.setEnabled(store.getSettings().keepComputerAwakeWhileAgentsRun)
  // Why: start from empty — disk-hydrated status rows are UI continuity only; only this runtime's hook events keep the computer awake.
  agentAwakeService.setStatuses([])
  unsubscribeAgentAwakeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    agentAwakeService?.setStatuses(statuses)
  })
  // Why: telemetry must init before any IPC handler/renderer can call track(); it's a no-op in dev and while TELEMETRY_ENABLED is false, so it's safe early.
  initTelemetry(store)
  // Why: the trust-grant module is bundled into plain-node CLI entries where
  // the telemetry client cannot load, so the tracker is injected here instead
  // of imported there.
  setCodexTrustGrantTelemetry(({ outcome, hostKind, reason }) => {
    track('codex_trust_grant', {
      outcome,
      host_kind: hostKind,
      ...(reason !== undefined ? { fallback_reason: reason } : {})
    })
  })
  // Why: the error-tracking lane (telemetry-error-tracking.md) is its own
  // composition root — independent of product telemetry — and must
  // initialize before any IPC handler / runtime span is created so the
  // tracer's active sink is populated at the moment the first span fires.
  // Honors DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / ORCA_DIAGNOSTICS_DISABLED
  // / CI internally; those gates do not need to be re-checked here.
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  // Why: cohort-classifier reads repo count synchronously at every emit, so hydrate it here — before any IPC handler or window can trigger track().
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  stats = new StatsCollector()
  claudeUsage = new ClaudeUsageStore(store)
  codexUsage = new CodexUsageStore(store)
  openCodeUsage = new OpenCodeUsageStore(store)
  rateLimits = new RateLimitService()
  codexRuntimeHome = new CodexRuntimeHomeService(store)
  // Why: an incapable trust-grant host must fall back to the managed home for
  // every consumer (PTY env, rate limits, commit messages) in one place.
  codexRuntimeHome.setRealHomeLaneGate(() => isRealHomeCodexHookLaneUsable())
  // Why: while the real-home lane owns ~/.codex/hooks.json, the legacy
  // system-home sweep inside managed installs would delete the entry the
  // real-home installer just appended. Flag OFF, hooks off, or an incapable
  // trust lane re-arms the sweep so downgrade, opt-out, and rollback converge.
  setSystemCodexHomeHookSweepSuppressed(
    () =>
      codexRuntimeHome !== null &&
      codexRuntimeHome.isHostSystemDefaultRealHome() &&
      isAgentStatusHooksEnabled(store?.getSettings())
  )
  const codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () => codexRuntimeHome?.isHostSystemDefaultRealHome() === true,
    isQuitting: () => isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store!.getSettings()),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome, {
    onHostSystemDefaultSelected: codexSessionMigration.requestRun
  })
  // Why: one-time per-host backfill makes historical Orca-managed Codex
  // sessions visible to the user's own resume picker and app history (#4444,
  // #8612). Deferred so startup and first PTY spawns never compete with the
  // sessions tree walk.
  codexSessionMigration.scheduleInitialRun()
  claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver((target) =>
    codexRuntimeHome!.prepareForRateLimitFetch(target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    // Why: auto is a live policy; retarget only providers whose settings-derived runtime changed.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
  })
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth!.prepareForRateLimitFetch(target)
  )
  // Why: live Claude sessions stream usage windows through their statusLine command; feeding them here avoids OAuth usage-endpoint polling (and its 429s).
  agentHookServer.setClaudeStatusLineListener((event) => {
    rateLimits?.ingestLiveClaudeRateLimits(event)
  })
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
    getLegacyOverrides: () => store!.getSettings().keybindings,
    legacyTabSwitchSeed: {
      isPending: () => store!.getSettings().tabSwitchKeybindingSeed === 'pending',
      markSeeded: () => {
        store!.updateSettings({ tabSwitchKeybindingSeed: 'done' })
      }
    }
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
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Why: resolve the PTY provider lazily — a daemon swap happens later, so an eager reference would freeze the pre-daemon provider (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: SSH relay providers register after construction and may reconnect, so destructive cleanup must resolve the current generation.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    onPtyStopped: clearProviderPtyState,
    onTerminalAgentStatus: (event) => {
      agentHookServer.ingestTerminalStatus(event)
    },
    // Why: serve can be promoted in place, so wire the listener from startup; runtime enables desktop-only scanners only for a ready renderer.
    onTerminalSideEffects: (batch: TerminalSideEffectBatch) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    getDesktopWindowStatus: getDesktopWindowStatus,
    // Why: worktree.ps pulls hook-reported agent status (same source as the desktop sidebar) at query time so mobile shows the same agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    // Why: source codex-home here (runs in window AND serve) so aiVault.listSessions includes managed-Codex sessions; registerCoreHandlers is window-only.
    getAdditionalAiVaultCodexHomePaths: () =>
      codexRuntimeHome ? codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery() : [],
    prepareAiVaultSessionResume: (args) =>
      prepareLegacySharedCodexSessionResume(args, {
        isHostSystemDefaultRealHome: () => codexRuntimeHome?.isHostSystemDefaultRealHome() === true,
        systemCodexHomePath: resolveHostCodexSessionSourceHome(store!.getSettings())
      }),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store?.getSettings()) ? agentHookServer.buildPtyEnv() : {}
  })
  runtime = runtimeService
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtimeService.notifyMobileSessionTabsChanged(worktreeId)
  })
  automations = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    // Why: desktop clients mirror remote-host automations, but only a server process should execute remote_host_service-owned schedules.
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
    // Why: Codex hooks/auth live in Orca's managed runtime home even for the default path, so every launch must resolve CODEX_HOME via runtime-home.
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
  // Why: externally started serve-sim processes must stay independent — only Orca-managed/attached helpers belong to a workspace.
  const emulatorBridge = new EmulatorBridge()
  runtimeService.setEmulatorBridge(emulatorBridge)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  if (codexRuntimeHome.isHostSystemDefaultRealHomeSelected()) {
    // Why: establish capability before managed-hook reconciliation so an
    // incapable host re-arms and completes the legacy real-home sweep now.
    ensureRealHomeCodexHookState({
      hooksEnabled: isAgentStatusHooksEnabled(store.getSettings()),
      userDataPath: app.getPath('userData')
    })
  }
  if (shouldInstallManagedHooks(is.dev)) {
    // Why: check the persisted off switch before any auto-install so removed hooks don't silently reappear on launch.
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
    appMenuLabel: devInstanceIdentity.name,
    onCheckForUpdates: (options) => runUserInitiatedUpdateCheck(options),
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (mainWindow?.webContents.id === webContentsId) {
        markExpectedRendererReload(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    },
    onOpenSettings: openSettingsFromSystemMenu,
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
      // Why: use the invoking BrowserWindow so hidden/E2E and multi-window flows route to the right renderer, not global focus.
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenFeatureTour(targetBrowserWindow)
    },
    // Why: menu zoom must act on the window the user is looking at — routing to
    // the main window while the dashboard pop-out is focused zooms behind it.
    onZoomIn: () => {
      if (!zoomDashboardPopoutIfFocused('in')) {
        mainWindow?.webContents.send('terminal:zoom', 'in')
      }
    },
    onZoomOut: () => {
      if (!zoomDashboardPopoutIfFocused('out')) {
        mainWindow?.webContents.send('terminal:zoom', 'out')
      }
    },
    onZoomReset: () => {
      if (!zoomDashboardPopoutIfFocused('reset')) {
        mainWindow?.webContents.send('terminal:zoom', 'reset')
      }
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
        // Why: status bar visibility lives in persisted UI state (not settings) and the renderer owns the toggle — forward the event, let it flip + store.
        mainWindow?.webContents.send('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      // Why: these appearance settings are default-on, so a missing persisted value must toggle from visible -> hidden.
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
  // Why: parallel E2E Electron instances would race the fixed port (EADDRINUSE); port 0 gives each a random OS-assigned port.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  // Why: pin dev to 6769 so `pnpm dev` doesn't race packaged Orca on 6768 and fall back to a random port, breaking deterministic mobile pairing/repro (STA-1511).
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  let serveOptions: ServeOptions | null = null
  try {
    serveOptions = isServeMode ? getServeOptions() : null
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  // Why: existing installs may have pairing creds under the late app.getPath('userData'); copy them forward before switching to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Why: mobile pairing needs the stable pre-setName() path (getCanonicalUserDataPath), not a late app.getPath('userData') that drops paired devices across restarts.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    ...(isE2E ? { wsPort: 0 } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined
      ? {
          wsPort: serveOptions.wsPort,
          // Why: only explicit `orca serve --port` overrides a stale STA-1511 fallback (issue #8535); default/dev stay fallback-first for pairing stability.
          preferPinnedWsPort: true
        }
      : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  registerMobileHandlers(runtimeRpc, { getRelayStatus: () => desktopRelayStatus })

  startTerminalRuntimeStartupServices()
  app.on('activate', requestDesktopActivation)

  if (serveOptions) {
    // Why: give managed WSL launchers a brief chance to migrate before headless PTYs go live, without slow repairs withholding all RPC readiness.
    logStartupMilestone('wsl-cli-barrier-start')
    await managedWslCliStartupBarrierReady
    logStartupMilestone('wsl-cli-barrier-resolved', {
      reconciliation: managedWslCliReconciliationStatus
    })
    // Why: headless PTYs must not start on the fallback provider, then get swept when an activated renderer registers desktop lifecycle handlers.
    await localPtyStartupReady
    registerHeadlessPtyRuntime(
      runtime,
      prepareCodexRuntimeHomeForLaunch,
      () => store!.getSettings(),
      (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
      store,
      prepareCodexSessionResumeForLaunch
    )
    // Why: headless servers can't mount <webview> panes; use offscreen WebContents, gated on a real display so browser.headless.v1 stays honest.
    if (headlessBrowserDisplayAvailable) {
      runtime.setOffscreenBrowserBackend(new OffscreenBrowserBackend(browserManager))
    }
    // Why: headless servers have no renderer graph publisher; publish an explicit empty graph so status clients see a ready server.
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start headless RPC transport:', error)
      throw error
    })
    settleServeDesktopActivation()
    installServeSignalHandlers()
    // Why: headless serve has no renderer to run the normal cli:install flow; do it here for macOS/Linux only (Windows-excluded: install() only mutates registry PATH, not child terminals).
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
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
    // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
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

  // Why: window and RPC startup run in parallel; registerPtyHandlers gates PTY spawns so RPC binds without racing the daemon provider swap.
  const [win] = await Promise.all([
    Promise.resolve(openMainWindow()),
    runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start local RPC transport:', error)
    })
  ])

  const cloudAuth = getOrcaCloudAuthConfig()
  if (cloudAuth.configured) {
    try {
      const relayService = new DesktopRelayService({
        authConfig: cloudAuth.config,
        userDataPath: getProfileUserDataPath(),
        appVersion: app.getVersion(),
        runtimeRpc,
        onStatus: (status) => {
          desktopRelayStatus = status
          mainWindow?.webContents.send('mobile:relayStatusChanged', status)
        }
      })
      desktopRelayService = relayService
      runtimeRpc.setMobileRelayPairingProvider({
        createPairingRelay: (relayDeviceId) => relayService.createPairingRelay(relayDeviceId),
        onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
        onDemandStateChanged: () => relayService.demandStateChanged(),
        getEndpoints: (context, params) => relayService.getEndpoints(context, params),
        provisionRelay: (context, params) => relayService.provisionRelay(context, params)
      })
      relayService.start()
    } catch (error) {
      console.warn(
        '[relay] Desktop relay startup unavailable:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // Why: macOS notification permission dialog must fire after the window is shown, else it's hidden behind the maximized window.
  win.once('show', () => {
    // Why: store can be null if init failed earlier; bail rather than throw inside an Electron event listener.
    if (!store) {
      return
    }
    const onboarding = store.getOnboarding()
    if (onboarding.closedAt !== null) {
      triggerStartupNotificationRegistration(store)
    }
  })
})

app.on('before-quit', () => {
  if (isQuittingForUpdate()) {
    recordUpdaterLifecycle('before_quit_allowed', undefined, {
      message: 'before-quit allowed for update install'
    })
  }
  isQuitting = true
  desktopRelayService?.fenceAndCloseNow()
  runtimeRpc?.setMobileRelayPairingProvider(null)
  unsubscribeSystemResumeBroadcast?.()
  unsubscribeSystemResumeBroadcast = null
  unsubscribeAgentAwakeStatusChanges?.()
  unsubscribeAgentAwakeStatusChanges = null
  agentAwakeService?.dispose()
  agentAwakeService = null
  // Why: defer PTY cleanup to will-quit so the renderer captures scrollback before PTY-exit events unmount TerminalPane (dropping its capture callbacks).
  rateLimits?.stop()
})

// Why: will-quit fires twice — first pass runs sync cleanup + preventDefault to await checkpoint writes; second pass exits.
let daemonDisconnectDone = false
app.on('will-quit', (e) => {
  const updateQuitInProgress = isQuittingForUpdate()
  if (updateQuitInProgress) {
    recordUpdaterLifecycle(
      'will_quit_cleanup_started',
      { daemonTeardown: 'disconnect' },
      { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
    )
  }
  // Why: before-quit can still be aborted by renderer beforeunload; only remove the Windows tray icon on the committed quit path.
  destroySystemTray()
  // Why: stats.flush() must precede killAllPty() so still-running agents emit synthetic agent_stop events (killAllPty skips runtime.onPtyExit()).
  starNag?.stop()
  automations?.stop()
  setUnreadDockBadgeCount(0)
  agentHookServer.stop()
  // Why: cancels relay restart/reinstall timers and kills wsl.exe children deterministically, not via stdio-pipe teardown.
  wslHookRelayManager.disposeAll()
  stats?.flush()
  // Why: agent-browser daemon processes would otherwise linger after quit, holding ports and stale session state on disk.
  runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  // Why: headless offscreen browser windows are main-process owned; tear them down explicitly on quit.
  runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
  browserManager.setBrowserGuestStateChangedListener(null)
  const emulatorShutdown = runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
  killAllPty()
  const watcherShutdown = shutdownWatchersOnce()
  store?.flush()

  // Why: preventDefault to await disconnectDaemon's async checkpoint writes (else data lost); guard prevents an infinite quit loop on the re-fired will-quit.
  if (!daemonDisconnectDone) {
    e.preventDefault()
    // Why: capture pid/runtimeId synchronously (before any await) so a later teardown path can't null them out mid-chain.
    const ownedPid = process.pid
    const ownedRuntimeId = runtime?.getRuntimeId()
    // Why: keep inside the !daemonDisconnectDone guard so the re-fired will-quit doesn't re-run RPC.stop()/metadata-clear against the updater's replacement process.
    const rpcStopAndClear = runtimeRpc
      ? runtimeRpc
          .stop()
          .then(() => awaitRuntimeFileWatcherUnsubscribes())
          .then(() => {
            if (ownedRuntimeId) {
              // Why: must match the path the runtime server wrote metadata to (getCanonicalUserDataPath), not late app.getPath('userData').
              clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
            }
          })
          .catch((error) => {
            console.error('[runtime] Failed to stop local RPC transport:', error)
          })
      : Promise.resolve()
    // Why: allSettled (not all) keeps fail-open — a daemon-disconnect rejection still quits instead of hanging.
    // Why: telemetry flush folds in before app.quit() (bounded 2s); catch defensively so a flush failure can't cancel the quit chain.
    // Why: normal quits keep the detached daemon for warm reattach, but a dead dev parent leaves the temp/dev profile ownerless.
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
  // Why: serve mode / disposable offscreen browser windows must not take down runtime RPC — the policy fn keeps the app alive.
  // Why: on macOS a quit-in-progress (Cmd+Q) is canceled by the renderer buffer-capture deferral; re-trigger quit so it actually exits.
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
