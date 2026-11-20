import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DesktopCore } from './desktop-core'
import type { Store } from '../persistence/loading-store/store'
import type { AutomationUsageClient } from '../../shared/backend/backend-service-contract'
import type { TerminalSideEffectBatch } from '../../shared/terminal/output/terminal-side-effect-facts'
import type { RuntimeDesktopWindowStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentBrowserBridge } from '../browser/agent-browser/agent-browser-bridge'
import type { BrowserClientPageAutomationRpc } from '../browser/client-pages/execution/browser-client-page-automation-runtime'
import { StarNagService } from '../star-nag/service'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  DESKTOP_RPC_CALLER,
  LOCAL_CLI_RPC_CALLER
} from '../runtime/rpc/callers/rpc-caller-identity'
import { BrowserExpectedUrlMismatch } from '../../shared/browser/client-hosting/browser-expected-url'
import { BrowserClientPageCommandError } from '../browser/client-pages/execution/browser-client-page-command-failure'
import { startCodexHooks } from '../codex/hooks/reconciliation/codex-hook-reconcile'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/history/index/codex-state-db-backfill-recovery'
import { getOrcaManagedCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import { hydrateAgentCliShellPath } from '../agent-hooks/installation/local-agent-cli-presence'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { reconcileStartupManagedAgentHooks } from '../agent-hooks/installation/managed-agent-hook-startup'
import { shouldInstallManagedHooks } from '../startup/configure-process'
import { installFirstWorkRenameHookSubscription } from '../agent-hooks/first-work/first-work-rename-hook-subscription'
import { firstWorkRenameDeps } from '../agent-hooks/first-work/first-work-rename-runtime'
import { initializeMainProcessAccountServices } from '../startup/agent-accounts/main-process-account-services'
import {
  initializeMainProcessRuntime,
  configureRuntimeServices
} from '../startup/runtime-startup/main-process-runtime-service'
import { createRuntimeAutomationService } from '../automations/runtime-automation-service'
import { createRendererShutdownCheckpointService } from './renderer-shutdown-checkpoint-service'
import { initializeMainProcessPlugins } from '../startup/plugin-startup/main-process-plugins'
import {
  collectWorktreeTrashSweepRoots,
  sweepStaleWorktreeTrash
} from '../workspaces/removal/worktree-trash'
import { prepareWorktreeRemovalsForStore } from '../workspaces/removal/worktree-removal-records-load'
import { worktreeRemovalLifetime } from '../workspaces/removal/worktree-removal-lifetime'
import { logStartupMilestone } from '../startup/diagnostics/startup-diagnostics'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/status-hooks/opencode-status-plugin-startup-refresh'
import { pruneDesktopOrcadArtifactCache } from '../orcad/artifact-slots/orcad-artifact-cache-retention'
import { runGatedWslMoveDesktopRewritePass } from '../persistence/moving-wsl-projects/desktop-state/wsl-move-desktop-rewrite'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import { reapLeftoverMacOSPermissionStatusHelpers } from '../computer/macos-permissions/macos-permission-status-leftover-reap'
import { repairDuplicatePtyPanesOnStart } from '../runtime/terminal/identity/moved-pane-owner-rekey'
import { WslUsageReporter } from '../telemetry/wsl-usage-reporter'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods/rpc-method-registry'
import { startWorkspaceCleanupRunner } from '../workspaces/cleanup/workspace-cleanup-runner-startup'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/runtime/hook-status-session-tabs-republish'
import { installRepoMaintenanceIdleGate } from '../workspaces/catalog/repo-maintenance-idle-gate'
import { recoverPendingSkillTransactions } from '../skills/transaction-state/skill-transaction-startup-recovery'
import { initCohortClassifier } from '../telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from '../telemetry/onboarding-cohort-classifier'
import { StatsCollector } from '../stats/collector'
import { UsageWorktreeHistory } from '../usage/worktree-attribution/usage-worktree-history'
import { feedAgentSessionStats } from '../stats/agent-session-stats-feed'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

// Headless serve has no first window; timer fallback must still sweep trash.
const WORKTREE_TRASH_SWEEP_FALLBACK_MS = 15_000

export type DesktopCorePaths = {
  userData: string
  home: string
  isPackaged: boolean
}

/** What the composing process supplies: native effects and facts the core cannot own. */
export type DesktopCoreNative = {
  isQuitting(): boolean
  isServeMode(): boolean
  servedOrcaProfileId(): string | undefined
  openExternal(url: string): Promise<void>
  /** Power, presence, awake, telemetry and hang observers, started right after removal records load. */
  startObservers(): void
  getWorkingAgentCount(): number
  startUsageBackend(history: UsageWorktreeHistory): {
    claudeUsage: AutomationUsageClient
    codexUsage: AutomationUsageClient
  }
  getDesktopWindowStatus(): RuntimeDesktopWindowStatus
  sendTerminalSideEffects(batch: TerminalSideEffectBatch): void
  attachBrowserHost(runtime: OrcaRuntimeService): void
  createAgentBrowserBridge(onTabsChanged: (worktreeId?: string) => void): AgentBrowserBridge
  configureBrowserAutomation(executeRpc: BrowserClientPageAutomationRpc): void
  afterFirstWindowShown(task: () => void, fallbackMs: number): void
  /** Speech warmup, theme sync and theme source, at their place after core's deferred maintenance. */
  startThemeAndSpeech(fallbackMs: number): void
  /** Child-process crash sampling, registered before the duplicate-pane repair await. */
  startCrashObservers(): void
}

export type DesktopCoreComposition = {
  store: Store
  paths: DesktopCorePaths
  native: DesktopCoreNative
  /** Runs at process quit; the composing process decides when that is. */
  registerCleanup: (cleanup: () => void) => void
}

function startCoreObservers(core: DesktopCore, store: Store, deps: DesktopCoreComposition): void {
  const { native, paths } = deps
  core.uninstallRepoMaintenanceIdleGate = installRepoMaintenanceIdleGate({
    isQuitting: native.isQuitting,
    getWorkingAgentCount: native.getWorkingAgentCount
  })
  core.uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => core.runtime
  )
  core.skillTransactionRecovery = recoverPendingSkillTransactions(
    join(paths.userData, 'skill-installs')
  )
  void core.skillTransactionRecovery
    .then((report) => {
      const result = report as {
        scanned: number
        recovered: number
        failures: { code: string }[]
        truncated: boolean
      }
      if (result.scanned || result.failures.length || result.truncated) {
        console.info('[skills] startup transaction recovery:', {
          scanned: result.scanned,
          recovered: result.recovered,
          failures: result.failures.map((failure) => failure.code),
          truncated: result.truncated
        })
      }
    })
    .catch((error) => console.warn('[skills] startup transaction recovery failed:', error))
  // Hydrate repo count before IPC/window tracking; cohort classification reads it synchronously.
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  core.stats = new StatsCollector()
  feedAgentSessionStats(core.stats, agentHookServer)
  const usageWorktrees = new UsageWorktreeHistory(
    store,
    join(getCanonicalUserDataPath(), 'orca-usage-worktree-history.json')
  )
  core.usageWorktreeHistory = usageWorktrees
  const usage = native.startUsageBackend(usageWorktrees)
  core.claudeUsage = usage.claudeUsage
  core.codexUsage = usage.codexUsage
}

function startBrowserAutomation(
  core: DesktopCore,
  runtime: OrcaRuntimeService,
  native: DesktopCoreNative
): void {
  const agentBrowserBridge = native.createAgentBrowserBridge((worktreeId) =>
    runtime.notifyMobileSessionTabsChanged(worktreeId)
  )
  runtime.setAgentBrowserBridge(agentBrowserBridge)
  // Reclaim browser daemons orphaned by prior crashes/SIGKILL.
  void agentBrowserBridge.sweepOrphanedSessions()
  const dispatcher = new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS })
  native.configureBrowserAutomation(async (method, params, agent, signal) => {
    const response = await dispatcher.dispatch(
      { id: randomUUID(), authToken: 'local-browser-client-automation', method, params },
      // Why: the cursor, glow and tab badge key off an agent caller; relayed people are not one.
      { signal, caller: agent ? LOCAL_CLI_RPC_CALLER : DESKTOP_RPC_CALLER }
    )
    if (!response.ok) {
      const mismatch = BrowserExpectedUrlMismatch.safeParse(response.error.data)
      throw new BrowserClientPageCommandError(response.error.code, {
        expectedUrlMismatch: mismatch.success ? mismatch.data : undefined,
        detail: response.error.message
      })
    }
    return response.result
  })
  // Only Orca-managed emulator helpers belong to workspaces; external serve-sim stays independent. macOS capability gates live in CLI/runtime.
  core.emulatorBridge = new EmulatorBridge()
  runtime.setEmulatorBridge(core.emulatorBridge)
}

function scheduleDeferredMaintenance(
  runtime: OrcaRuntimeService,
  store: Store,
  { paths, native }: DesktopCoreComposition,
  releaseProviderMaintenance: () => void
): void {
  const afterFirstWindow = (task: () => void): void =>
    native.afterFirstWindowShown(task, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  // Finish recorded deletes and old trash left across crashes; defer disk sweeps so they do not compete with first paint/catalog hydration.
  afterFirstWindow(() => {
    releaseProviderMaintenance()
    void sweepStaleWorktreeTrash(
      collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
    ).catch((error) => {
      console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
    })
    worktreeRemovalLifetime.resume(() => runtime.finishInterruptedWorktreeRemovals())
  })
  // Defer noncritical plugin-file refresh past first paint.
  afterFirstWindow(() => {
    refreshInstalledOpenCodeStatusPlugins(store.getSettings())
  })
  afterFirstWindow(() => {
    new WslUsageReporter(store, paths.userData).start()
  })
  // Suspended permission probes left by older builds hold LaunchServices slots until every app launch hangs.
  afterFirstWindow(() => {
    void reapLeftoverMacOSPermissionStatusHelpers()
  })
  afterFirstWindow(() => {
    void pruneDesktopOrcadArtifactCache(paths.userData).catch((error) => {
      console.warn('[orcad-artifacts] Failed to bound the slot cache:', error)
    })
  })
  // The startup pass ran before browser sessions and any window existed, so `browser-cookies` paused.
  afterFirstWindow(() => {
    void runGatedWslMoveDesktopRewritePass({ userDataPath: paths.userData })
  })
}

/** Composes the desktop application core into `core`, in startup order, over the opened profile Store. */
export async function composeDesktopCore(
  core: DesktopCore,
  deps: DesktopCoreComposition
): Promise<void> {
  const { store, paths, native } = deps
  // Load interrupted deletion records before listings so first paint shows Deleting.
  await prepareWorktreeRemovalsForStore(store)
  native.startObservers()
  startCoreObservers(core, store, deps)
  await initializeMainProcessAccountServices(core, {
    store,
    homePath: paths.home,
    isQuitting: native.isQuitting,
    openExternal: native.openExternal
  })
  const runtime = initializeMainProcessRuntime(core, {
    store,
    stats: core.stats!,
    userDataPath: paths.userData,
    isPackaged: paths.isPackaged,
    servedOrcaProfileId: native.servedOrcaProfileId(),
    getDesktopWindowStatus: native.getDesktopWindowStatus,
    sendTerminalSideEffects: native.sendTerminalSideEffects,
    attachBrowserHost: native.attachBrowserHost,
    registerCleanup: deps.registerCleanup
  })
  if (!native.isServeMode()) {
    // Its copy is swapped in only by the desktop quit.
    runtime.allowOrchestrationDbCompaction()
  }
  core.rendererCheckpoint = createRendererShutdownCheckpointService(
    store,
    (session) => runtime.quitResumeRecordsFor(session),
    ORCA_LAYOUT_OWNER_IS_MAIN
      ? (session, partition) => runtime.shutdownReconnectFactsFor(session, partition)
      : undefined
  )
  core.automations = createRuntimeAutomationService({
    store,
    runtime,
    claudeUsage: core.claudeUsage!,
    codexUsage: core.codexUsage!,
    // Remote clients mirror schedules; only server processes execute remote_host_service ownership.
    allowRemoteHostScheduling: native.isServeMode()
  })
  startWorkspaceCleanupRunner(runtime, store)
  configureRuntimeServices(core, runtime, {
    store,
    userDataPath: paths.userData,
    isPackaged: paths.isPackaged
  })
  installFirstWorkRenameHookSubscription(firstWorkRenameDeps(store, runtime))
  await initializeMainProcessPlugins(core, store)
  core.starNag = new StarNagService(store, core.stats!)
  core.starNag.start()
  core.starNag.registerIpcHandlers()
  startBrowserAutomation(core, runtime, native)
  let releaseProviderMaintenance: () => void = () => {}
  const providerMaintenanceReady = new Promise<void>((resolve) => {
    releaseProviderMaintenance = resolve
  })
  scheduleDeferredMaintenance(runtime, store, deps, () => releaseProviderMaintenance())
  native.startThemeAndSpeech(WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  void providerMaintenanceReady.then(() =>
    startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  )
  // Register launch reconciliation now; defer background probes and scratch cleanup until first paint.
  startCodexHooks({
    startAfter: providerMaintenanceReady,
    pathReady: paths.isPackaged ? hydrateAgentCliShellPath() : Promise.resolve(),
    isEnabled: () => isAgentStatusHooksEnabledForAgent(store.getSettings(), 'codex'),
    resolveLaunchHome: () => {
      if (!core.codexRuntimeHome) {
        throw new Error('Codex runtime home service is not initialized')
      }
      return core.codexRuntimeHome.resolveHostCodexHomePathForLaunchReadOnly()
    }
  })
  if (shouldInstallManagedHooks(!paths.isPackaged)) {
    reconcileStartupManagedAgentHooks({
      getSettings: () => store.getSettings(),
      isQuitting: native.isQuitting,
      shouldHydrateShellPath: paths.isPackaged
    })
  }
  native.startCrashObservers()
  // Await duplicate-pane repair behind queued writes; all later phases must read the repaired tree.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await repairDuplicatePtyPanesOnStart(store, runtime)
  }
  logStartupMilestone('services-initialized')
}
