import {
  desktopWorkspaceSleepPlatform,
  installDesktopWorkspaceVmWaker,
  configureDesktopCloudServices
} from '../../runtime/construction/desktop-workspace-services'
import { setBeforeRuntimeEnvironmentRemoval } from '../../ipc/runtime-environments/catalog/runtime-environment-removal-hooks'
import { settlePairedServerAsksOnRemoval } from '../../runtime/orchestration/federation/paired-server-asks/paired-server-ask-removal'
import { wireRecipeWorkspaceRemoval } from '../../ephemeral-vm/recipe-workspace-removal-wiring'
import { wireGitHubIssueLinkTitleFill } from '../../github/workspace-links/github-issue-link-title-wiring'
import {
  applySessionSearchSettingsChange,
  installChildSessionSearchService
} from '../../ai-vault-search/session-search-enablement'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { sessionSearchScopeCatalogFromStore } from '../../ai-vault-search/scope/session-search-store-scope-catalog'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { translateMain } from '../../i18n/main-i18n'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getLocalPtyProvider } from '../../ipc/pty/provider/registry'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { toAgentStatusIpcPayload } from '../../agent-hooks/server/server-status-identity'
import { loadAgentSessionClaimSigner } from '../../runtime/agent-session/ownership/agent-session-claim-identity'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import type { Store } from '../../persistence/loading-store/store'
import type { StatsCollector } from '../../stats/collector'
import type { DesktopCore } from '../../core-desktop/desktop-core'
import { codexAiVaultSessionResumePreparation } from '../../codex/history/resume/codex-ai-vault-session-resume'
import { prepareCodexPinnedLaunchHome } from '../agent-accounts/codex-session-resume-launch'
import { resolveHostCodexSessionSourceHome } from '../../codex/history/rollouts/codex-session-source-home'
import { agentHookRuntimeDeps } from '../../agent-hooks/runtime/agent-hook-runtime-deps'
import { getDaemonProvider } from '../../daemon/providers/lifecycle/daemon-provider-state'
import type { TerminalSideEffectBatch } from '../../../shared/terminal/output/terminal-side-effect-facts'
import { resolveTuiAgentLaunchEnv } from '../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { createOrchestrationEnvironmentTransport } from '../../ipc/runtime-environments/requests/orchestration-environment-transport'
import { trackRuntimeEnvironmentVerifiedTransitions } from '../../ipc/runtime-environments/status/runtime-environment-verified-transitions'
import { onRuntimeEnvironmentStatusPublished } from '../../ipc/runtime-environments/status/runtime-environment-status-owner'
import { installWslOrcadAccountShim } from '../wsl-startup/wsl-orcad-account-env-wiring'
import {
  codexStructuredLaunchHomeResolvers,
  prepareCodexRuntimeHomeForLaunch
} from '../agent-accounts/codex-launch-preparation'
import { resolveHostAgentBaseEnvironment } from '../../runtime/agent-session/environment/structured-agent-shell-environment'
import type { RuntimeDesktopWindowStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { BotShareClient } from '../../bots/sharing/bot-share-client'
import { skillPackageDownloadOrigins } from '../../skills/runtime-transfer/skill-client-mediated-transfer'
import { join } from 'node:path'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../../runtime/terminal/identity/agent-status-observed-pane-identity'
import { bindTerminalPaneStatusLifecycle } from '../../ipc/pty/pane/terminal-pane-status-lifecycle'
import { startAgentStateRulesLiveUpdates } from '../../runtime/agent-state-rules/agent-state-rules-live-update'
import { recordDurableCrashBreadcrumb } from '../../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'
import { installLegacyJournalRetirementReporting } from '../../native-chat/agent-session-journal/journal-legacy-retirement-reporting'
import { providePairedDesktopComputerName } from '../../ipc/runtime-environments/connections/paired-desktop-account-declaration'
import { installMainProcessDingTalkLocal } from '../dingtalk-local/main-process-dingtalk-local-startup'

export type DesktopRuntimeServiceDeps = {
  store: Store
  stats: StatsCollector
  userDataPath: string
  isPackaged: boolean
  servedOrcaProfileId: string | undefined
  getDesktopWindowStatus: () => RuntimeDesktopWindowStatus
  sendTerminalSideEffects: (batch: TerminalSideEffectBatch) => void
  /** Browser guests, offscreen tab links and profile changes report into this runtime. */
  attachBrowserHost: (runtime: OrcaRuntimeService) => void
  registerCleanup: (cleanup: () => void) => void
}

export function initializeMainProcessRuntime(
  core: DesktopCore,
  deps: DesktopRuntimeServiceDeps
): OrcaRuntimeService {
  const { store, stats, userDataPath } = deps
  // Desktop and headless serve alike: whichever runs the profile's cleanup reports through here.
  installLegacyJournalRetirementReporting()
  // Process-scope subscription covers desktop, headless serve and fleet status.
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const runtime = new OrcaRuntimeService(store, stats, {
    getSetupTerminalTitle: () => translateMain('worktree.setupTerminalTitle', 'Setup'),
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () => store.getSettings()),
    prepareClaudeAuth: (target) => core.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Resolve provider lazily or later daemon adoption leaves a frozen pre-daemon reference (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    onPtyStopped: clearProviderPtyState,
    // Serve can activate in place; wire now, but enable desktop scanners only for a ready renderer.
    onTerminalSideEffects: deps.sendTerminalSideEffects,
    getDesktopWindowStatus: deps.getDesktopWindowStatus,
    servedOrcaProfileId: deps.servedOrcaProfileId,
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    // Resolve per call: the RPC server/device registry is constructed later with this runtime.
    getPairedDeviceName: (pairedDeviceId) =>
      core.runtimeRpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
    getPairedDeviceAccount: (pairedDeviceId, connectionClaim) =>
      core.runtimeRpc?.pairedDeviceTypist(pairedDeviceId, connectionClaim) ?? null,
    // Provide managed Codex homes here for desktop and headless session discovery; core IPC registration is window-only.
    getAdditionalAiVaultCodexHomePaths: () =>
      core.codexRuntimeHome?.getHostCodexHomePathsForSessionDiscovery() ?? [],
    prepareAiVaultSessionResume: codexAiVaultSessionResumePreparation(() => ({
      runtimeHome: core.codexRuntimeHome,
      systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings()),
      preparePinnedLaunchHome: (home) => prepareCodexPinnedLaunchHome(home)
    })),
    ...codexStructuredLaunchHomeResolvers,
    prepareCodexCatalogProbeHome: (homePath) =>
      core.codexRuntimeHome?.prepareHostCodexHomeForReadOnlyAppServer(
        homePath,
        resolveTuiAgentLaunchEnv('codex', store.getSettings())
      ),
    orchestrationEnvironmentTransport: {
      ...createOrchestrationEnvironmentTransport(),
      onEnvironmentVerified: (listener) =>
        onRuntimeEnvironmentStatusPublished(trackRuntimeEnvironmentVerifiedTransitions(listener))
    },
    workspaceSleepPlatform: desktopWorkspaceSleepPlatform(store, () => userDataPath),
    // Paired/local settings writes must reconcile the scanner child through the same path.
    applySessionSearchSettings: applySessionSearchSettingsChange,
    skillTransactionRecovery: core.skillTransactionRecovery
  })
  // Both desktop and headless serve own a host-local search service.
  const sessionSearch = installChildSessionSearchService({
    dataRoot: getCanonicalUserDataPath(),
    getSettings: () => store.getSettings(),
    // Read the host catalog per search so added repos/renamed workspaces are immediately in scope.
    getScopeCatalog: () => sessionSearchScopeCatalogFromStore(store, LOCAL_EXECUTION_HOST_ID)
  })
  deps.registerCleanup(() => sessionSearch?.dispose())
  // Desktop and headless hosts each evaluate their own panes' rules.
  startAgentStateRulesLiveUpdates(store, (rules) =>
    recordDurableCrashBreadcrumb('agent_state_rules_active', rules)
  )
  wireRecipeWorkspaceRemoval(runtime, store, () => userDataPath)
  // Each host titles its own workspaces' untitled GitHub issue links once, when they are linked.
  const disposeIssueLinkTitleFill = wireGitHubIssueLinkTitleFill(store, runtime)
  deps.registerCleanup(disposeIssueLinkTitleFill)
  bindTerminalPaneStatusLifecycle(runtime, store)
  core.runtime = runtime
  providePairedDesktopComputerName(() => runtime.readMachineName())
  installDesktopWorkspaceVmWaker(runtime, () => userDataPath)
  runtime.attachAgentStatusStore(agentHookServer)
  installMainProcessDingTalkLocal(runtime, store, userDataPath, deps.registerCleanup)
  agentHookServer.subscribeEnrichedStatus((enriched) =>
    recordObservedAgentStatusPaneIdentity(observedPaneIdentities, enriched, runtime)
  )
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
  agentHookServer.setClaudePermissionHolds(runtime.terminalWorkerApprovals)
  // Main records pane resume state from accepted status.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    agentHookServer.subscribeEnrichedStatus((enriched) =>
      runtime.recordHookStatusResume(toAgentStatusIpcPayload(enriched))
    )
    agentHookServer.subscribePaneStatusClear((clear) => runtime.forgetHookStatusResume(clear))
    agentHookServer.subscribeStatusDrop((paneKey) => runtime.forgetHookStatusResume({ paneKey }))
  }
  // Rehydrate before clients attach so restarted runtimes can return their owned pages.
  runtime.rehydrateClientHostedBrowserPages()
  deps.attachBrowserHost(runtime)
  runtime.startupWorkerAuthority.begin()
  setBeforeRuntimeEnvironmentRemoval((environmentId) =>
    settlePairedServerAsksOnRemoval(runtime, environmentId)
  )
  return runtime
}

export function configureRuntimeServices(
  core: DesktopCore,
  runtime: OrcaRuntimeService,
  {
    store,
    userDataPath,
    isPackaged
  }: Pick<DesktopRuntimeServiceDeps, 'store' | 'userDataPath' | 'isPackaged'>
): void {
  const claudeAccounts = core.claudeAccounts
  const codexAccounts = core.codexAccounts
  const rateLimits = core.rateLimits
  if (!claudeAccounts || !codexAccounts || !rateLimits) {
    throw new Error('Account services must be initialized before runtime wiring')
  }
  configureDesktopCloudServices(runtime, () => store.getSettings(), userDataPath)
  runtime.setBotShareClient(BotShareClient.forProfile(userDataPath), {
    temporaryRoot: join(userDataPath, 'bot-share-downloads'),
    allowedOrigins: skillPackageDownloadOrigins(!isPackaged),
    requireHttps: isPackaged
  })
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  installWslOrcadAccountShim(store)
  runtime.setCommitMessageAgentEnvironmentResolvers({
    // Resolve every Codex launch through runtime-home, including default-account hooks/auth.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => core.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
  })
}
