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
import { startPreGoneProcessMetricsSampling } from '../crash-reporting/process-gone-diagnostics'
import { recordProcessGoneCrash } from './main-window-lifecycle-flags'
import { handleGpuChildCrash } from './gpu-lifecycle'
import { isGpuFallbackCrashCandidate } from '../crash-reporting/gpu-crash-fallback-decision'
import { ensureRealHomeCodexHookState } from '../codex/codex-real-home-hook-install'
import {
  installManagedAgentHooks,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup,
  shouldInstallStartupManagedAgentHook
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
import { initializeMainProcessAutomations } from './main-process-automations'
import { initializeMainProcessPlugins } from './main-process-plugins'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from '../worktree-trash'
import { logStartupMilestone } from './startup-diagnostics'

export async function initializeReadyRuntimeServices(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before ready services')
  }
  initializeMainProcessObservers()
  initializeMainProcessAccountServices()
  const runtime = initializeMainProcessRuntime()
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
  // Why: worktree deletion renames the checkout aside and deletes it in the background, so a quit or
  // crash mid-delete can leave the moved directory on disk.
  void sweepStaleWorktreeTrash(
    collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
  ).catch((error) => {
    console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
  })
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why (#16441): the real-home grant runs a codex app-server session. It stays
  // ordered before managed-hook reconciliation — an incapable host must re-arm
  // and complete the legacy real-home sweep first — but awaiting it inline
  // stalled app init behind that session, so chain instead of blocking.
  const startupManagedHookSettings = store.getSettings()
  const shouldReconcileStartupManagedHooks =
    shouldInstallManagedHooks(is.dev) &&
    resolveStartupManagedHookAction(startupManagedHookSettings) === 'install'
  const realHomeCodexHookState =
    shouldReconcileStartupManagedHooks &&
    shouldInstallStartupManagedAgentHook(startupManagedHookSettings, 'codex') &&
    state.codexRuntimeHome?.isHostSystemDefaultRealHomeSelected()
      ? ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: app.getPath('userData')
        }).catch((error: unknown) => {
          console.warn('[codex-real-home-hooks] startup ensure failed:', error)
        })
      : Promise.resolve()
  // Why skip rather than remove when the off switch is set: the hook files are user-global but this
  // decision reads only THIS profile's settings, so removing here deletes the hooks every other Orca
  // instance depends on (STA-5679). Skipping already keeps removed hooks from reappearing on launch.
  if (shouldReconcileStartupManagedHooks) {
    const managedHookStore = store
    void realHomeCodexHookState
      .then(() =>
        installManagedAgentHooks(managedHookStore.getSettings(), {
          shouldHydrateShellPath: app.isPackaged,
          onInstallError: recordManagedHookInstallFailure,
          shouldContinue: (agent) =>
            shouldContinueManagedHookStartup(
              state.isQuitting,
              managedHookStore.getSettings(),
              agent
            )
        })
      )
      .catch((error: unknown) =>
        console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
      )
  }
  // Why: process-gone metrics only see survivors; retain a recent whole-app
  // snapshot for comparison in crash reports.
  startPreGoneProcessMetricsSampling()
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
