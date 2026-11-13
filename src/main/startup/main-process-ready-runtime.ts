import { app, nativeTheme } from 'electron'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { StarNagService } from '../star-nag/service'
import { AgentBrowserBridge } from '../browser/agent-browser/agent-browser-bridge'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  DESKTOP_RPC_CALLER,
  LOCAL_CLI_RPC_CALLER
} from '../runtime/rpc/callers/rpc-caller-identity'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { configureBrowserClientPageAutomationRuntime } from '../browser/client-pages/execution/browser-client-page-automation-runtime'
import { BrowserExpectedUrlMismatch } from '../../shared/browser/client-hosting/browser-expected-url'
import { BrowserClientPageCommandError } from '../browser/client-pages/execution/browser-client-page-command-failure'
import { startPreGoneCrashSampling } from '../crash-reporting/process-exits/process-gone-diagnostics'
import { refuseRealtimeSchedulingUnderZeroRtTime } from './linux-runtime/linux-realtime-scheduling-guard'
import { recordProcessGoneCrash } from './main-window/main-window-lifecycle-flags'
import { handleGpuChildCrash } from './gpu-recovery/gpu-lifecycle'
import { isGpuFallbackCrashCandidate } from '../crash-reporting/recovery/gpu-crash-fallback-decision'
import { startCodexHooks } from '../codex/hooks/reconciliation/codex-hook-reconcile'
import { hydrateAgentCliShellPath } from '../agent-hooks/installation/local-agent-cli-presence'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { reconcileStartupManagedAgentHooks } from '../agent-hooks/installation/managed-agent-hook-startup'
import { shouldInstallManagedHooks } from './configure-process'
import { mainProcessState as state } from './main-process-state'
import { initializeMainProcessObservers } from './main-process-observers'
import { installFirstWorkRenameHookSubscription } from './workspace-startup/branch-rename-hook'
import { initializeMainProcessAccountServices } from './agent-accounts/main-process-account-services'
import {
  initializeMainProcessRuntime,
  configureRuntimeServices
} from './runtime-startup/main-process-runtime-service'
import { initializeMainProcessAutomations } from './runtime-startup/main-process-automations'
import { initializeMainProcessPlugins } from './plugin-startup/main-process-plugins'
import {
  collectWorktreeTrashSweepRoots,
  sweepStaleWorktreeTrash
} from '../workspaces/removal/worktree-trash'
import { prepareWorktreeRemovalsForStore } from '../workspaces/removal/worktree-removal-records-load'
import { worktreeRemovalLifetime } from '../workspaces/removal/worktree-removal-lifetime'
import { runAfterFirstWindowShown } from './main-window/first-window-deferral'
import { startSpeechModelWarmup } from '../speech/speech-model-warmup'
import { logStartupMilestone } from './diagnostics/startup-diagnostics'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/status-hooks/opencode-status-plugin-startup-refresh'
import { pruneDesktopOrcadArtifactCache } from '../orcad/artifact-slots/orcad-artifact-cache-retention'
import { runGatedWslMoveDesktopRewritePass } from '../persistence/moving-wsl-projects/desktop-state/wsl-move-desktop-rewrite'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { repairDuplicatePtyPanesOnStart } from '../runtime/terminal/identity/moved-pane-owner-rekey'
import { WslUsageReporter } from '../telemetry/wsl-usage-reporter'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods/rpc-method-registry'
import { startClaudeCodeThemeSync } from '../claude/theme-sync/claude-code-theme-sync-schedule'

// Headless serve has no first window; timer fallback must still sweep trash.
const WORKTREE_TRASH_SWEEP_FALLBACK_MS = 15_000

export async function initializeReadyRuntimeServices(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before ready services')
  }
  // Renderers fork from zygotes that exist already, so this must land before the first window.
  await refuseRealtimeSchedulingUnderZeroRtTime()
  // Load interrupted deletion records before listings so first paint shows Deleting.
  await prepareWorktreeRemovalsForStore(store)
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
  // Reclaim browser daemons orphaned by prior crashes/SIGKILL.
  void state.agentBrowserBridge.sweepOrphanedSessions()
  const browserClientAutomationDispatcher = new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS })
  configureBrowserClientPageAutomationRuntime({
    browserManager,
    getAgentBrowserBridge: () => state.agentBrowserBridge,
    executeRpc: async (method, params, agent, signal) => {
      const response = await browserClientAutomationDispatcher.dispatch(
        { id: randomUUID(), authToken: 'local-browser-client-automation', method, params },
        // Why: the cursor, glow and tab badge key off an agent caller; relayed people are not one.
        { signal, caller: agent ? LOCAL_CLI_RPC_CALLER : DESKTOP_RPC_CALLER }
      )
      if (!response.ok) {
        const mismatch = BrowserExpectedUrlMismatch.safeParse(response.error.data)
        throw new BrowserClientPageCommandError(response.error.code, {
          expectedUrlMismatch: mismatch.success ? mismatch.data : undefined
        })
      }
      return response.result
    }
  })
  // Only Orca-managed emulator helpers belong to workspaces; external serve-sim stays independent. macOS capability gates live in CLI/runtime.
  state.emulatorBridge = new EmulatorBridge()
  runtime.setEmulatorBridge(state.emulatorBridge)
  // Finish recorded deletes and old trash left across crashes; defer disk sweeps so they do not compete with first paint/catalog hydration.
  runAfterFirstWindowShown(() => {
    void sweepStaleWorktreeTrash(
      collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
    ).catch((error) => {
      console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
    })
    worktreeRemovalLifetime.resume(() => runtime.finishInterruptedWorktreeRemovals())
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  // Defer noncritical plugin-file refresh past first paint.
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
  // The startup pass ran before browser sessions and any window existed, so `browser-cookies` paused.
  runAfterFirstWindowShown(() => {
    void runGatedWslMoveDesktopRewritePass({ userDataPath: app.getPath('userData') })
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  // Load the dictation model after first paint; coming back to Orca re-warms one the idle timer unloaded.
  runAfterFirstWindowShown(() => {
    app.on('browser-window-focus', startSpeechModelWarmup(store))
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  runAfterFirstWindowShown(() => {
    startClaudeCodeThemeSync({
      getSettings: () => store.getSettings(),
      onSettingsChanged: (listener) => store.onSettingsChanged(listener),
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
      onSystemThemeChanged: (listener) => nativeTheme.on('updated', listener),
      onAppFocused: (listener) => app.on('browser-window-focus', listener),
      userDataPath: app.getPath('userData')
    })
  }, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Wait for shell PATH before probing Codex; start reconciliation early so first launch can share it.
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
  // Sample live processes: gone-time metrics omit dead children and already-released memory.
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
  // Await duplicate-pane repair behind queued writes; all later phases must read the repaired tree.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await repairDuplicatePtyPanesOnStart(store, runtime)
  }
  logStartupMilestone('services-initialized')
}
