import { wireRecipeWorkspaceRemoval } from '../ephemeral-vm/recipe-workspace-removal-wiring'
import { wireGitHubIssueLinkTitleFill } from '../github/github-issue-link-title-wiring'
import {
  applySessionSearchSettingsChange,
  installChildSessionSearchService
} from '../ai-vault-search/session-search-enablement'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { sessionSearchScopeCatalogFromStore } from '../ai-vault-search/scope/session-search-store-scope-catalog'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { app } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { clearProviderPtyState } from '../ipc/pty/provider/state-cleanup'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { toAgentStatusIpcPayload } from '../agent-hooks/server/server-status-identity'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { browserSessionRegistry } from '../browser/sessions/profiles/browser-session-registry'
import { loadAgentSessionClaimSigner } from '../runtime/agent-session/ownership/agent-session-claim-identity'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { codexAiVaultSessionResumePreparation } from '../codex/history/resume/codex-ai-vault-session-resume'
import { prepareCodexPinnedLaunchHome } from './codex-session-resume-launch'
import { resolveHostCodexSessionSourceHome } from '../codex/history/rollouts/codex-session-source-home'
import { agentHookRuntimeDeps } from '../agent-hooks/runtime/agent-hook-runtime-deps'
import { getDaemonProvider } from '../daemon/providers/lifecycle/daemon-provider-state'
import type { TerminalSideEffectBatch } from '../../shared/terminal/output/terminal-side-effect-facts'
import { resolveTuiAgentLaunchEnv } from '../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { createOrchestrationEnvironmentTransport } from '../ipc/runtime-environments/orchestration-environment-transport'
import { trackRuntimeEnvironmentVerifiedTransitions } from '../ipc/runtime-environments/runtime-environment-verified-transitions'
import { onRuntimeEnvironmentStatusPublished } from '../ipc/runtime-environments/runtime-environment-status-owner'
import { mainProcessState as state } from './main-process-state'
import { suspendEphemeralVmWorkspace } from '../ephemeral-vm/workspace-suspend'
import {
  acceptEphemeralVmWorkspaceWake,
  resumeEphemeralVmWorkspace
} from '../ephemeral-vm/workspace-resume'
import { registerRecipeVmWaker } from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { setSshHostAsleepCheck } from '../ssh/connection/ssh-host-sleep-hold'
import {
  isRecipeVmSshTargetAsleep,
  setRecipeVmAsleepStoreRoot
} from '../ephemeral-vm/recipe-vm-asleep'
import { openRecipeVmEnvironment } from '../ipc/runtime-environments/runtime-environment-recipe-vm-wake'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { findWorkspaceEphemeralVmRuntime } from '../../shared/ephemeral-vm-workspace-runtime'
import { installWslOrcadAccountShim } from './wsl-orcad-account-env-wiring'
import {
  codexStructuredLaunchHomeResolvers,
  prepareCodexRuntimeHomeForLaunch
} from './codex-launch-preparation'
import { resolveHostAgentBaseEnvironment } from '../runtime/agent-session/environment/structured-agent-shell-environment'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import { SkillCloudService } from '../skills/cloud/skill-cloud-package-service'
import { isArtifactSharingEnabled } from '../../shared/artifacts/artifact-sharing-gate'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../runtime/terminal/identity/agent-status-observed-pane-identity'
import { startAgentStateRulesLiveUpdates } from '../runtime/agent-state-rules/agent-state-rules-live-update'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import { openOffscreenBrowserPageLink } from '../runtime/browser/commands/offscreen-browser-page-link'

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
    // Provide managed Codex homes here for desktop and headless session discovery; core IPC registration is window-only.
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
    orchestrationEnvironmentTransport: {
      ...createOrchestrationEnvironmentTransport(),
      onEnvironmentVerified: (listener) =>
        onRuntimeEnvironmentStatusPublished(trackRuntimeEnvironmentVerifiedTransitions(listener))
    },
    workspaceSleepPlatform: {
      callEnvironment: (environmentId, method, params, timeoutMs) =>
        callRuntimeEnvironment(
          getRuntimeEnvironmentRegistryRoot(),
          environmentId,
          method,
          params,
          timeoutMs
        ),
      ownsVm: (workspaceId) =>
        findWorkspaceEphemeralVmRuntime(app.getPath('userData'), workspaceId) !== undefined,
      suspendVm: (workspaceId) => suspendEphemeralVmWorkspace(store, workspaceId),
      acceptWake: (workspaceId) => acceptEphemeralVmWorkspaceWake(workspaceId),
      resumeVm: (workspaceId, request) => resumeEphemeralVmWorkspace(store, workspaceId, request)
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
  wireRecipeWorkspaceRemoval(runtime, store, () => app.getPath('userData'))
  // Each host titles its own workspaces' untitled GitHub issue links once, when they are linked.
  const disposeIssueLinkTitleFill = wireGitHubIssueLinkTitleFill(store, runtime)
  app.once('will-quit', disposeIssueLinkTitleFill)
  state.runtime = runtime
  // Opening a recipe VM's workspace from a client wakes the VM through the runtime's one owner.
  registerRecipeVmWaker({
    state: (workspaceId, suspended) => runtime.workspaceVmState(workspaceId, suspended),
    noteOpened: (workspaceId) => runtime.noteWorkspaceReopened(workspaceId),
    holdOpen: (workspaceId, suspended, timeoutMs, signal) =>
      runtime.holdWorkspaceVmOpen(workspaceId, suspended, timeoutMs, signal),
    openEnvironment: (selector) => {
      const root = getRuntimeEnvironmentRegistryRoot()
      return openRecipeVmEnvironment(root, resolveEnvironment(root, selector))
    }
  })
  // A sleeping VM's SSH host takes no background login until its workspace wakes (#36363).
  setRecipeVmAsleepStoreRoot(getRuntimeEnvironmentRegistryRoot)
  setSshHostAsleepCheck((targetId) => isRecipeVmSshTargetAsleep(app.getPath('userData'), targetId))
  runtime.attachAgentStatusStore(agentHookServer)
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
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtime.notifyMobileSessionTabsChanged(worktreeId)
  })
  browserManager.setOffscreenTabOpener((request) =>
    openOffscreenBrowserPageLink(
      (params, caller) => runtime.browserTabCreate(params, caller),
      request
    )
  )
  browserSessionRegistry.onProfilesChanged = () => runtime.notifyBrowserProfilesChanged()
  runtime.startupWorkerAuthority.begin()
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
  const backend = state.backend
  if (!backend) {
    throw new Error('Usage backend must be initialized before runtime wiring')
  }
  runtime.usageHistory.setInvoker((method, params, purpose) =>
    backend.invokeUsage(method, params, purpose)
  )
  installWslOrcadAccountShim(store)
  runtime.setCommitMessageAgentEnvironmentResolvers({
    // Resolve every Codex launch through runtime-home, including default-account hooks/auth.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
  })
}
