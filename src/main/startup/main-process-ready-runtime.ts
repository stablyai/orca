import { app, nativeTheme } from 'electron'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { is } from '@electron-toolkit/utils'
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
import {
  installManagedAgentHooks,
  isAgentStatusHooksEnabledForAgent,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
} from '../agent-hooks/managed-agent-hook-controls'
import { shouldInstallManagedHooks } from './configure-process'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { mainProcessState as state } from './main-process-state'
import { initializeMainProcessObservers } from './main-process-observers'
import { initializeMainProcessAccountServices } from './main-process-account-services'
import {
  initializeMainProcessRuntime,
  configureRuntimeServices
} from './main-process-runtime-service'
import { initializeMainProcessScheduledMessages } from './main-process-scheduled-messages'
import { initializeMainProcessAutomations } from './main-process-automations'
import { initializeMainProcessPlugins } from './main-process-plugins'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from '../worktree-trash'
import { loadWorktreeRemovalRecordsForStore } from './worktree-removal-records-load'
import { runAfterFirstWindowShown } from './first-window-deferral'
import { logStartupMilestone } from './startup-diagnostics'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/opencode-status-plugin-startup-refresh'
import { pruneDesktopOrcadArtifactCache } from '../orcad/orcad-artifact-cache-retention'

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
  // Subscribes to runtime idle events, so it must exist before any pane can
  // start emitting — and before registerCoreHandlers reads it.
  initializeMainProcessScheduledMessages(runtime)
  initializeMainProcessAutomations()
  configureRuntimeServices(runtime)
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
  const startupManagedHookSettings = store.getSettings()
  const shouldReconcileStartupManagedHooks =
    shouldInstallManagedHooks(is.dev) &&
    resolveStartupManagedHookAction(startupManagedHookSettings) === 'install'
  // Why skip rather than remove when the off switch is set: the hook files are user-global but this
  // decision reads only THIS profile's settings, so removing here deletes the hooks every other Orca
  // instance depends on (STA-5679). Skipping already keeps removed hooks from reappearing on launch.
  if (shouldReconcileStartupManagedHooks) {
    const managedHookStore = store
    void installManagedAgentHooks(managedHookStore.getSettings(), {
      shouldHydrateShellPath: app.isPackaged,
      onInstallError: recordManagedHookInstallFailure,
      shouldContinue: (agent) =>
        shouldContinueManagedHookStartup(state.isQuitting, managedHookStore.getSettings(), agent)
    }).catch((error: unknown) =>
      console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
    )
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
  logStartupMilestone('services-initialized')
}
