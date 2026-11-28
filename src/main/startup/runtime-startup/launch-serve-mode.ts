import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../../runtime/terminal/adoption/unshown-live-terminal-placement'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import { registerHeadlessPtyRuntime } from '../../ipc/pty/register-headless-runtime'
import { publishHeadlessRuntimeGraph } from '../../runtime/session-graph/headless-runtime-graph'
import { OffscreenBrowserBackend } from '../../browser/backends/offscreen-browser-backend'
import { memorySaverIdleMs } from '../../browser/backends/offscreen-page-idle-freeing'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { startMainProcessRelayService } from '../cloud-startup/main-process-relay-startup'
import type { ServeOptions } from '../serve-launch/serve-options'
import { printServeReady } from '../serve-launch/main-process-serve'
import { handleCodexHomePtySpawned, handlePtyExit } from '../pty-startup/main-process-pty-startup'
import { prepareCodexRuntimeHomeForLaunch } from '../agent-accounts/codex-launch-preparation'
import { prepareCodexSessionResumeForLaunch } from '../agent-accounts/codex-session-resume-launch'
import { installServeQuitHandling } from '../serve-launch/serve-quit-handling'
import { registerHeadlessServeSshHandlers } from '../serve-launch/headless-serve-ssh-registration'
import { registerCliForHeadlessServe } from '../serve-launch/serve-cli-registration'
import { scheduleAllPendingHistoryTreeRemovals } from '../../pty/history/terminal-history-deletion'
import { startDesktopPushService } from '../cloud-startup/main-process-push-startup'
import { connectMainProcessConnectorCloud } from '../cloud-startup/main-process-connector-startup'
import { mainProcessState as state } from '../main-process-state'
import { logStartupMilestone } from '../diagnostics/startup-diagnostics'
import { setupHeadlessServeAutoUpdater } from '../../updater/lifecycle/main-window-updater'
import { preserveStateBeforeUpdateRestart } from '../../core-desktop/update-restart-preservation'
import { scheduleAgentLaunchRecordWarmup } from '../agent-accounts/agent-launch-record-warmup'
import { emitServeBrowserIdentityActionLine } from '../../server/serve-stdout-boundary'
import { getBrowserIdentityModeStatus } from '../../browser/identity/mode/browser-identity-mode-store'
import { chatJournalHostServing } from './chat-journal-startup'
import { e2eHeadlessServeWithoutBrowser } from '../serve-launch/e2e-headless-serve-without-browser'
import { settleDesktopActivation } from './runtime-launch-activation'

type RuntimeService = NonNullable<typeof state.core.runtime>

export async function launchServeMode(
  runtime: RuntimeService,
  runtimeRpc: OrcaRuntimeRpcServer,
  serveOptions: ServeOptions
): Promise<void> {
  // Headless serve has no first paint to prioritize; apply persisted proxy before relay/CLI/RPC fetchers.
  await state.initialProxyApplicationReady
  connectMainProcessConnectorCloud()
  // Give WSL registration brief migration time without letting slow repair hold all RPC readiness.
  logStartupMilestone('wsl-cli-barrier-start')
  await state.managedWslCliStartupBarrierReady
  logStartupMilestone('wsl-cli-barrier-resolved', {
    reconciliation: state.managedWslCliReconciliationStatus
  })
  // Headless PTYs must not use fallback before desktop activation swaps providers.
  await state.localPtyStartupReady
  await state.localPtyProviderStartupReady
  await registerHeadlessPtyRuntime(
    runtime,
    prepareCodexRuntimeHomeForLaunch,
    () => state.store!.getSettings(),
    (target) => state.core.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    state.store!,
    prepareCodexSessionResumeForLaunch,
    { onCodexHomePtySpawned: handleCodexHomePtySpawned, onPtyExit: handlePtyExit }
  )
  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()
  runtime.startupWorkerAuthority.finish()
  void runtime.reportWorkerStopsAcrossRestartOnce()
  // Main places unshown live terminals before any client attaches.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  // Headless hosts need display-backed offscreen WebContents; advertise browser capability only when usable.
  if (state.headlessBrowserDisplayAvailable && !e2eHeadlessServeWithoutBrowser()) {
    runtime.setOffscreenBrowserBackend(
      new OffscreenBrowserBackend(browserManager, {
        getAgentBrowserBridge: () => state.agentBrowserBridge,
        onPageNavigated: (page) => runtime.serveBrowserPageNavigated(page),
        isPageSaved: (page) => runtime.serveBrowserTabs.isSaved(page),
        idleFreeMs: () => memorySaverIdleMs(state.store?.getSettings())
      })
    )
    // Tabs saved under a profile an older build deleted would otherwise stay listed but never load.
    void runtime.browserCloseServerPagesOfMissingProfiles()
  }
  publishHeadlessRuntimeGraph(runtime)
  // Register SSH before binding RPC so the first paired client sees targets.
  await registerHeadlessServeSshHandlers(state.store!, runtime)
  await runtimeRpc.start().catch((error) => {
    console.error('[runtime] Failed to start headless RPC transport:', error)
    throw error
  })
  // After RPC has its pairing identity, so a signed-in server reaches phones through the relay too.
  startMainProcessRelayService(runtimeRpc)
  scheduleAgentLaunchRecordWarmup(null)
  // Serve pushes like the desktop: its own attention (chat turns, bot runs) reaches paired phones through this service.
  startDesktopPushService(runtimeRpc)
  settleDesktopActivation()
  installServeQuitHandling()
  await registerCliForHeadlessServe()
  // Headless automation cannot wait for a renderer that never opens.
  state.core.automations?.start()
  // Arm history-removal GC without a window so interrupted serve deletions do not leak until desktop launch.
  void scheduleAllPendingHistoryTreeRemovals()
  emitServeBrowserIdentityActionLine(getBrowserIdentityModeStatus())
  await printServeReady(serveOptions)
  chatJournalHostServing()
  const store = state.store!
  setupHeadlessServeAutoUpdater(state.nativeSettings!, runtime, {
    onBeforeUpdateQuit: () =>
      preserveStateBeforeUpdateRestart({ codexRuntimeHome: state.core.codexRuntimeHome, store }),
    onBeforeUpdateQuitFailure: 'abort',
    isServeMode: true
  })
}
