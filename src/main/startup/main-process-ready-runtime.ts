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
import { loadWorktreeRemovalRecords } from '../worktree-background-removal'
import { runAfterFirstWindowShown } from './first-window-deferral'
import { logStartupMilestone } from './startup-diagnostics'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/opencode-status-plugin-startup-refresh'
import { CliInstaller } from '../cli/cli-installer'

// Headless serve never opens a window, so the sweep still has to run off a timer there.
const WORKTREE_TRASH_SWEEP_FALLBACK_MS = 15_000

export async function initializeReadyRuntimeServices(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before ready services')
  }
  // Why before any listing: a delete a quit or crash interrupted must show as Deleting from first paint.
  await loadWorktreeRemovalRecords(store.getProfileStorageDirectory())
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
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why: the real-home ensure stays ordered before managed-hook reconciliation, so its
  // in-slot conversion lands before the managed install's retired-form sweep removes
  // the prior command. Codex's approval then runs in the background (#16441).
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
          userDataPath: app.getPath('userData'),
          // Why app start: the one place an older build's entry becomes the frozen command.
          writePolicy: 'convert-older-forms'
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
  // Why not inside install(): a Windows PATH entry already registered is not
  // rewritten on launch, so the PowerShell ASCII pipe would stay broken (#24428).
  if (process.platform === 'win32') {
    void Promise.resolve()
      .then(() =>
        new CliInstaller({
          syncWindowsPowerShellProfile: true,
          windowsDocumentsPath: app.getPath('documents')
        }).syncWindowsPowerShellCliShim()
      )
      .catch((error: unknown) => {
        console.warn('[cli] failed to refresh the Windows PowerShell UTF-8 shim:', error)
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
  logStartupMilestone('services-initialized')
}
