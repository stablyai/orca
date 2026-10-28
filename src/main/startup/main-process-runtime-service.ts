import {
  applySessionSearchSettingsChange,
  installChildSessionSearchService
} from '../ai-vault-search/session-search-enablement'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { sessionSearchScopeCatalogFromStore } from '../ai-vault-search/session-search-store-scope-catalog'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { app } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { clearProviderPtyState } from '../ipc/pty/provider/state-cleanup'
import { agentHookServer } from '../agent-hooks/server'
import { toAgentStatusIpcPayload } from '../agent-hooks/server/server-status-identity'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { loadAgentSessionClaimSigner } from '../runtime/agent-session/ownership/agent-session-claim-identity'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { codexAiVaultSessionResumePreparation } from '../codex/codex-ai-vault-session-resume'
import { prepareCodexPinnedLaunchHome } from './codex-session-resume-launch'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { getDaemonProvider } from '../daemon/daemon-provider-state'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { OrchestrationEnvironmentTransport } from '../runtime/orchestration/environment-transport'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { fingerprintOrchestrationPeer } from '../runtime/orchestration/environment-transport'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { mainProcessState as state } from './main-process-state'
import { suspendEphemeralVmWorkspace } from '../ephemeral-vm/workspace-suspend'
import { installWslOrcadAccountShim } from './wsl-orcad-account-env-wiring'
import {
  codexStructuredLaunchHomeResolvers,
  prepareCodexRuntimeHomeForLaunch
} from './codex-launch-preparation'
import { resolveHostAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import { SkillCloudService } from '../skills/skill-cloud-service'
import { isArtifactSharingEnabled } from '../../shared/artifact-sharing-gate'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../runtime/agent-status-observed-pane-identity'
import { startAgentStateRulesLiveUpdates } from '../runtime/agent-state-rules/agent-state-rules-live-update'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

export function getDesktopWindowStatus(): RuntimeDesktopWindowStatus {
  const activation = state.desktopActivationGate
  if (!activation) {
    return 'available'
  }
  const value = activation.getState()
  return value === 'ready' ? 'openable' : value
}

export function initializeMainProcessRuntime(): OrcaRuntimeService {
  const store = state.store
  const stats = state.stats
  if (!store || !stats) {
    throw new Error('Store and stats must be initialized before runtime')
  }
  const orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport = {
    resolve: (selector) => {
      const environment = resolveEnvironment(app.getPath('userData'), selector)
      const connection = getPreferredPairedRuntimeConnection(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(connection.hostPublicKeyB64),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    call: (selector, method, params, timeoutMs, envelope, expectedPairingRevision) =>
      callRuntimeEnvironment(
        app.getPath('userData'),
        selector,
        method,
        params,
        timeoutMs,
        expectedPairingRevision,
        envelope
      )
  }
  // Process-scope subscription covers desktop, headless serve and fleet status.
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const runtime = new OrcaRuntimeService(store, stats, {
    getSetupTerminalTitle: () => translateMain('worktree.setupTerminalTitle', 'Setup'),
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      state.store?.getSettings()
    ),
    prepareClaudeAuth: (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Resolve provider lazily or later daemon adoption leaves a frozen pre-daemon reference (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    onPtyStopped: clearProviderPtyState,
    // Serve can activate in place; wire now, but enable desktop scanners only for a ready renderer.
    onTerminalSideEffects: (batch: TerminalSideEffectBatch) => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    getDesktopWindowStatus,
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    // Resolve per call: the RPC server/device registry is constructed later with this runtime.
    getPairedDeviceName: (pairedDeviceId) =>
      state.runtimeRpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
    // Why: source codex-home here (runs in window AND serve) so aiVault.listSessions includes managed-Codex sessions; registerCoreHandlers is window-only.
    getProjectOwnershipCatalog: () =>
      sessionSearchScopeCatalogFromStore(store, LOCAL_EXECUTION_HOST_ID),
    getAdditionalAiVaultCodexHomePaths: () =>
      state.codexRuntimeHome?.getHostCodexHomePathsForSessionDiscovery() ?? [],
    prepareAiVaultSessionResume: codexAiVaultSessionResumePreparation(() => ({
      runtimeHome: state.codexRuntimeHome,
      systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings()),
      preparePinnedLaunchHome: (home) => prepareCodexPinnedLaunchHome(home)
    })),
    ...codexStructuredLaunchHomeResolvers,
    prepareCodexCatalogProbeHome: (homePath) =>
      state.codexRuntimeHome?.prepareHostCodexHomeForReadOnlyAppServer(
        homePath,
        resolveTuiAgentLaunchEnv('codex', store.getSettings())
      ),
    orchestrationEnvironmentTransport,
    workspaceSleepPlatform: {
      callEnvironment: (environmentId, method, params, timeoutMs) =>
        callRuntimeEnvironment(app.getPath('userData'), environmentId, method, params, timeoutMs),
      suspendVm: (workspaceId) => suspendEphemeralVmWorkspace(store, workspaceId)
    },
    // Paired/local settings writes must reconcile the scanner child through the same path.
    applySessionSearchSettings: applySessionSearchSettingsChange,
    skillTransactionRecovery: state.skillTransactionRecovery
  })
  // Both desktop and headless serve own a host-local search service.
  const sessionSearch = installChildSessionSearchService({
    dataRoot: getCanonicalUserDataPath(),
    getSettings: () => store.getSettings(),
    // Read the host catalog per search so added repos/renamed workspaces are immediately in scope.
    getScopeCatalog: () => sessionSearchScopeCatalogFromStore(store, LOCAL_EXECUTION_HOST_ID)
  })
  app.once('will-quit', () => sessionSearch?.dispose())
  // Desktop and headless hosts each evaluate their own panes' rules.
  startAgentStateRulesLiveUpdates(store, (rules) =>
    recordDurableCrashBreadcrumb('agent_state_rules_active', rules)
  )
  state.runtime = runtime
  runtime.attachAgentStatusStore(agentHookServer)
  agentHookServer.subscribeEnrichedStatus((enriched) =>
    recordObservedAgentStatusPaneIdentity(observedPaneIdentities, enriched, runtime)
  )
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
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
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtime.notifyMobileSessionTabsChanged(worktreeId)
  })
  browserSessionRegistry.onProfilesChanged = () => runtime.notifyBrowserProfilesChanged()
  return runtime
}

export function configureRuntimeServices(runtime: OrcaRuntimeService): void {
  const store = state.store
  const claudeAccounts = state.claudeAccounts
  const codexAccounts = state.codexAccounts
  const rateLimits = state.rateLimits
  if (!store || !claudeAccounts || !codexAccounts || !rateLimits) {
    throw new Error('Account services must be initialized before runtime wiring')
  }
  runtime.setArtifactService(
    new ArtifactCloudService(app.getPath('userData'), () =>
      isArtifactSharingEnabled(state.store?.getSettings())
    )
  )
  runtime.setSkillCloudService(new SkillCloudService(app.getPath('userData')))
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  installWslOrcadAccountShim(store)
  runtime.setCommitMessageAgentEnvironmentResolvers({
    // Resolve every Codex launch through runtime-home, including default-account hooks/auth.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
  })
}
