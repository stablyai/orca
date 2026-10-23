import { app, nativeTheme } from 'electron'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { StarNagService } from '../star-nag/service'
import { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { browserManager } from '../browser/browser-manager'
import { configureBrowserClientPageAutomationRuntime } from '../browser/browser-client-page-automation-runtime'
import { BrowserClientPageCommandError } from '../browser/browser-client-page-command-failure'
import { startPreGoneCrashSampling } from '../crash-reporting/process-gone-diagnostics'
import { recordProcessGoneCrash } from './main-window-lifecycle-flags'
import { handleGpuChildCrash } from './gpu-lifecycle'
import { isGpuFallbackCrashCandidate } from '../crash-reporting/gpu-crash-fallback-decision'
import { startCodexHooks } from '../codex/codex-hook-reconcile'
import { hydrateAgentCliShellPath } from '../agent-hooks/local-agent-cli-presence'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { reconcileStartupManagedAgentHooks } from '../agent-hooks/managed-agent-hook-startup'
import { shouldInstallManagedHooks } from './configure-process'
import { mainProcessState as state } from './main-process-state'
import { initializeMainProcessObservers } from './main-process-observers'
import { installFirstWorkRenameHookSubscription } from './branch-rename-hook'
import { initializeMainProcessAccountServices } from './main-process-account-services'
import {
  initializeMainProcessRuntime,
  configureRuntimeServices
} from './main-process-runtime-service'
import { initializeMainProcessAutomations } from './main-process-automations'
import { initializeMainProcessPlugins } from './main-process-plugins'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from '../worktree-trash'
import { loadWorktreeRemovalRecordsForStore } from './worktree-removal-records-load'
import { runAfterFirstWindowShown } from './first-window-deferral'
import { logStartupMilestone } from './startup-diagnostics'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/opencode-status-plugin-startup-refresh'
import { pruneDesktopOrcadArtifactCache } from '../orcad/orcad-artifact-cache-retention'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { repairDuplicatePtyPanesOnStart } from '../runtime/moved-pane-owner-rekey'
import { WslUsageReporter } from '../telemetry/wsl-usage-reporter'

// Headless serve never opens a window, so the sweep still has to run off a timer there.
const WORKTREE_TRASH_SWEEP_FALLBACK_MS = 15_000

export async function initializeReadyRuntimeServices(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before ready services')
  }
  // Why before any listing: a delete a quit or crash interrupted must show as Deleting from first paint.
  await loadWorktreeRemovalRecordsForStore(store)
  initializeMainProcessObservers()
  initializeMainProcessAccountServices()
  const runtime = initializeMainProcessRuntime()
  initializeMainProcessAutomations()
  configureRuntimeServices(runtime)
  installFirstWorkRenameHookSubscription()
  await initializeMainProcessPlugins(runtime)
  state.starNag = new StarNagService(store, state.stats!)
  state.starNag.start()
  state.starNag.registerIpcHandlers()
  state.agentBrowserBridge = new AgentBrowserBridge(browserManager, {
    onTabsChanged: (worktreeId) => runtime.notifyMobileSessionTabsChanged(worktreeId)
  })
  runtime.setAgentBrowserBridge(state.agentBrowserBridge)
  // Why: daemons a crashed or SIGKILL'd previous run left behind answer to nobody; nothing else reclaims them.
  void state.agentBrowserBridge.sweepOrphanedSessions()
  const browserClientAutomationDispatcher = new RpcDispatcher({ runtime })
  configureBrowserClientPageAutomationRuntime({
    browserManager,
    getAgentBrowserBridge: () => state.agentBrowserBridge,
    executeRpc: async (method, params, signal) => {
      const response = await browserClientAutomationDispatcher.dispatch(
        { id: randomUUID(), authToken: 'local-browser-client-automation', method, params },
        { signal }
      )
      if (!response.ok) {
        throw new BrowserClientPageCommandError(response.error.code)
      }
      return response.result
    }
  })
  // Emulator bridge (serve-sim). macOS-only feature (gated in CLI/runtime); always ship like agent-browser.
  // Why: externally started serve-sim processes must stay independent — only Orca-managed/attached helpers belong to a workspace.
  state.emulatorBridge = new EmulatorBridge()
  runtime.setEmulatorBridge(state.emulatorBridge)
  // Why: older releases renamed removed checkouts into a trash root and deleted them in the background,
  // so a quit mid-delete left directories on disk; drain them. Removals this version recorded are
  // finished by the same delete. Why deferred: both touch disk on the same libuv threadpool the
  // window's first paint and worktree-catalog hydration read on, and startup consumes neither.
  runAfterFirstWindowShown(() => {
    void sweepStaleWorktreeTrash(
      collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
    ).catch((error) => {
      console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
    })
    runtime.finishInterruptedWorktreeRemovals()
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  // Why deferred: nothing on the startup path needs it, and it only rewrites plugin files that changed.
  runAfterFirstWindowShown(() => {
    refreshInstalledOpenCodeStatusPlugins(store.getSettings())
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  runAfterFirstWindowShown(() => {
    new WslUsageReporter(store, app.getPath('userData')).start()
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  runAfterFirstWindowShown(() => {
    void pruneDesktopOrcadArtifactCache(app.getPath('userData')).catch((error) => {
      console.warn('[orcad-artifacts] Failed to bound the slot cache:', error)
    })
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why here, after PATH hydration: the first Codex launch usually finds Codex's hook hash ready,
  // and launches find the reconcile in flight before CLI detection ends.
  startCodexHooks({
    pathReady: app.isPackaged ? hydrateAgentCliShellPath() : Promise.resolve(),
    isEnabled: () => isAgentStatusHooksEnabledForAgent(store.getSettings(), 'codex'),
    resolveLaunchHome: () => {
      if (!state.codexRuntimeHome) {
        throw new Error('Codex runtime home service is not initialized')
      }
      return state.codexRuntimeHome.resolveHostCodexHomePathForLaunchReadOnly()
    }
  })
  if (shouldInstallManagedHooks(!app.isPackaged)) {
    reconcileStartupManagedAgentHooks({
      getSettings: () => store.getSettings(),
      isQuitting: () => state.isQuitting,
      shouldHydrateShellPath: app.isPackaged
    })
  }
  // Why: process-gone metrics only see survivors, and the gone-time host memory
  // read lands after the corpse released its pages; both need a live pre-gone
  // sample to compare against in crash reports.
  startPreGoneCrashSampling()
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
      const crashedAt = performance.now()
      void state.gpuCrashDiagnostics?.record()
      void handleGpuChildCrash(details.reason, details.exitCode ?? null, crashedAt)
    }
  })
  // Switch point: awaited, as it queues behind in-flight writes and every later phase must read its tree.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await repairDuplicatePtyPanesOnStart(store, runtime)
  }
  logStartupMilestone('services-initialized')
}
