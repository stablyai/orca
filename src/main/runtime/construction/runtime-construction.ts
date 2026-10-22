import type {
  RuntimeConstructionBindings,
  RuntimeConstructionDependencies
} from './runtime-construction-dependencies'
import type { OrcaRuntimeWithRuntimeId as IdentityState } from './runtime-identity-state'
import type { OrcaRuntimeWithStopRequestedPtyIds as ServiceState } from './runtime-service-state'
import type { OrcaRuntimeWithPreservedBranchCleanup as HostServices } from './runtime-host-services'
import type { RuntimeFileCommandSurface } from '../runtime-file-command-surface'
import type { RuntimeGitCommandSurface } from '../runtime-git-command-surface'
import type { RuntimeRepositoryCommandSurface } from '../runtime-repository-command-surface'
import type { RuntimeReviewCommandSurface } from '../runtime-review-command-surface'
import type { RuntimeServiceCommandSurface } from '../runtime-service-command-surface'
import type { RuntimeSkillCommandSurface } from '../runtime-skill-command-contract'
import type { RuntimeEdgeCommandSurface } from '../runtime-edge-command-controller'
import type { OrcaRuntimeWithListManagedWorktrees as ListManagedWorktrees } from '../workspaces/managed-workspace-operations'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { OrcaRuntimeWithLinearCommands } from '../integrations/linear/linear-commands'

import type { RuntimeStore } from '../runtime-store-contract'
import type { StatsCollector } from '../../stats/collector'

import type { PrepareClaudeAuth } from '../../ipc/pty/host-env/types'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'

import { installRuntimeFileCommandSurface } from '../runtime-file-command-surface'
import { installRuntimeGitCommandSurface } from '../runtime-git-command-surface'
import { installRuntimeRepositoryCommandSurface } from '../runtime-repository-command-surface'
import { installRuntimeReviewCommandSurface } from '../runtime-review-command-surface'
import { installRuntimeServiceCommandSurface } from '../runtime-service-command-surface'
import { RuntimeSkillCommands } from '../runtime-skill-command-surface'
import { installRuntimeSkillCommandSurface } from '../runtime-skill-command-contract'
import { getAppEnvironment } from '../../../shared/app-environment'
import { RuntimeClientSettingsController } from '../runtime-client-settings'
import { RuntimeSessionSearchSettingsController } from '../runtime-session-search-settings'
import { RuntimeAutomationController } from '../runtime-automation-controller'
import { RuntimeOrchestrationFederation } from '../runtime-orchestration-federation'
import { configureAiVaultSessionSources } from '../../ai-vault/cached-session-list'
import { configureHostReadableTranscriptPathSources } from '../../native-chat/host-readable-transcript-path'
import { createEphemeralAgentSessionClaimSigner } from '../agent-session-claim-identity'
import { registerConptyDa1OverrideInstaller } from '../terminal-model-query-authority'
import { registerTerminalViewAttributesApplier } from '../terminal-view-attribute-store'
import { RuntimeMachineName } from '../runtime-machine-name'
import { setPRConflictSummaryRemoteFetches } from '../../github/conflict-summary'

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- SAFETY: The constructor installs every checked canonical surface.
export abstract class OrcaRuntimeWithStateFields extends OrcaRuntimeWithLinearCommands {
  // Earlier layers allocate these slots; this constructor assigns their readonly values.
  declare protected readonly getLocalProviderFn: HostServices['getLocalProviderFn']
  declare readonly onPtyStopped: HostServices['onPtyStopped']
  declare protected readonly onTerminalAgentStatus: HostServices['onTerminalAgentStatus']
  declare protected readonly onTerminalProgramStatusFacet: HostServices['onTerminalProgramStatusFacet']
  declare protected readonly onTerminalSideEffects: HostServices['onTerminalSideEffects']
  declare protected readonly onClaudeTerminalEvidence: HostServices['onClaudeTerminalEvidence']
  declare readonly getAgentStatusSnapshotFn: HostServices['getAgentStatusSnapshotFn']
  declare protected readonly structuredAgentStatusSinkFn: HostServices['structuredAgentStatusSinkFn']
  declare readonly readObservedAgentStatusPaneIdentityFn: HostServices['readObservedAgentStatusPaneIdentityFn']
  declare protected readonly getAgentProviderSessionSnapshotFn: HostServices['getAgentProviderSessionSnapshotFn']
  declare protected readonly getAgentProviderSessionRowsForPaneFn: HostServices['getAgentProviderSessionRowsForPaneFn']
  declare protected readonly attestAgentHookCompatibilityAuthorityFn: HostServices['attestAgentHookCompatibilityAuthorityFn']
  declare protected readonly retireAgentHookCompatibilityAuthorityFn: HostServices['retireAgentHookCompatibilityAuthorityFn']
  declare protected readonly readHookCliWriterObservationFn:
    | RuntimeConstructionBindings['readHookCliWriterObservation']
    | null
  declare protected readonly checkHookAgentPresenceFn: HostServices['checkHookAgentPresenceFn']
  declare protected readonly reconcileAgentStatusForEndedProcessFn: HostServices['reconcileAgentStatusForEndedProcessFn']
  declare protected readonly forgetHookAgentExitFn: HostServices['forgetHookAgentExitFn']
  declare protected readonly dropAgentStatusForRemovedWorktreeFn: HostServices['dropAgentStatusForRemovedWorktreeFn']
  declare protected readonly canRecoverPersistentLocalPtysFn: HostServices['canRecoverPersistentLocalPtysFn']
  declare protected readonly getPairedDeviceNameFn: HostServices['getPairedDeviceNameFn']
  declare protected readonly buildAgentHookPtyEnv: HostServices['buildAgentHookPtyEnv']
  declare protected readonly getDesktopWindowStatusFn: HostServices['getDesktopWindowStatusFn']
  declare protected readonly prepareAiVaultSessionResumeFn: HostServices['prepareAiVaultSessionResumeFn']
  declare protected readonly prepareCodexStructuredLaunchFn: HostServices['prepareCodexStructuredLaunchFn']
  declare protected readonly resolveCodexStructuredLaunchHomeFn: HostServices['resolveCodexStructuredLaunchHomeFn']
  declare protected readonly prepareCodexCatalogProbeHomeFn: HostServices['prepareCodexCatalogProbeHomeFn']
  declare protected readonly agentSessionClaimSigner: HostServices['agentSessionClaimSigner']
  declare protected readonly store: IdentityState['store']
  declare protected readonly clientSettings: IdentityState['clientSettings']
  declare protected readonly automation: IdentityState['automation']
  declare protected readonly orchestrationEnvironmentTransport: IdentityState['orchestrationEnvironmentTransport']
  declare protected readonly orchestrationFederation: IdentityState['orchestrationFederation']
  declare protected readonly skillCommands: ServiceState['skillCommands']

  abstract showManagedWorktree(
    worktreeSelector: string
  ): ReturnType<ListManagedWorktrees['showManagedWorktree']>
  abstract resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined
  protected abstract ensureNativeWindowsConptyDa1Override(ptyId: string): void

  protected readonly prepareClaudeAuth?: PrepareClaudeAuth

  protected readonly getAgentStatusSnapshotForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null

  protected readonly machineName = new RuntimeMachineName(
    () => this.store?.getSettings?.().machineName
  )

  constructor(
    store: RuntimeStore | null = null,
    stats?: StatsCollector,
    deps?: RuntimeConstructionDependencies
  ) {
    super()
    this.store = store
    this.machineName.start()
    this.prepareClaudeAuth = deps?.prepareClaudeAuth
    // oxlint-disable-next-line typescript/no-this-alias -- SAFETY: Preserve the constructor receiver captured by callbacks.
    const runtime: this = this
    installRuntimeFileCommandSurface(runtime, this.fileCommands)
    installRuntimeGitCommandSurface(runtime, this.gitCommands)
    installRuntimeRepositoryCommandSurface(runtime, {
      projectHostSetups: this.projectHostSetups,
      projectGroups: this.projectGroups,
      nestedRepoImport: this.nestedRepoImport,
      serverEnvironment: this.serverEnvironment,
      repositorySparsePresets: this.repositorySparsePresets,
      repositoryRegistrations: this.repositoryRegistrations,
      repositoryClones: this.repositoryClones,
      repositorySettings: this.repositorySettings,
      repositoryRefQueries: this.repositoryRefQueries,
      hostedReviews: this.hostedReviews,
      gitHubRepositoryQueries: this.gitHubRepositoryQueries,
      repositoryHooks: this.repositoryHooks,
      repositoryIssueCommand: this.repositoryIssueCommand
    })
    installRuntimeReviewCommandSurface(runtime, {
      gitLabQueries: this.gitLabQueryCommands,
      gitLabMutations: this.gitLabMutationCommands,
      gitHubReviewQueries: this.gitHubReviewQueries,
      gitHubReviewMutations: this.gitHubReviewMutations,
      gitHubIssueComments: this.gitHubIssueComments,
      gitHubProjects: this.gitHubProjectCommands
    })
    installRuntimeServiceCommandSurface(runtime, {
      aiVault: this.aiVault,
      sessionSearchSettings: new RuntimeSessionSearchSettingsController(
        store,
        deps?.applySessionSearchSettings ?? null
      ),
      clientEvents: this.clientEvents,
      nativeChatDraftResolutions: this.nativeChatDraftResolutions,
      subscriptions: this.subscriptions,
      mobileNotifications: this.mobileNotifications,
      accounts: this.accounts,
      mobileSpeech: this.mobileSpeech,
      mobileDictation: this.mobileDictation,
      browserDrivers: this.browserDrivers,
      messageWaiters: this.messageWaiters
    })
    this.skillCommands = new RuntimeSkillCommands({
      getRuntimeId: () => this.runtimeId,
      getUserDataPath: () => getAppEnvironment().getPath('userData'),
      isPackaged: () => getAppEnvironment().isPackaged(),
      getSettings: () => this.store?.getSettings?.() ?? {},
      listRepos: () => this.listRepos(),
      listFolderWorkspaces: () =>
        (this.store?.getFolderWorkspaces?.() ?? []).map((workspace) => ({
          id: workspace.id,
          folderPath: workspace.folderPath,
          connectionId: workspace.connectionId,
          executionHostId: workspace.executionHostId
        })),
      listResolvedWorktrees: () => this.listResolvedWorktrees(),
      showManagedWorktree: (selector) => this.showManagedWorktree(selector),
      resolveProjectRuntimeForWorktree: (worktreeId) =>
        this.resolveProjectRuntimeForWorktree(worktreeId),
      getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target),
      skillTransactionRecovery: (deps?.skillTransactionRecovery ?? Promise.resolve()).catch(
        (error) => {
          console.warn('[skills] startup transaction recovery failed:', error)
        }
      )
    })
    installRuntimeSkillCommandSurface(runtime, this.skillCommands)
    Object.assign(this, this.edgeCommands.surface)
    this.clientSettings = new RuntimeClientSettingsController(store, () =>
      this.notifyReposChanged()
    )
    this.automation = new RuntimeAutomationController(store, {
      showRepo: (selector) => runtime.showRepo(selector),
      showManagedWorktree: (selector) => this.showManagedWorktree(selector)
    })
    // Why: per-device tab selections must survive host restarts, or every phone snaps back to the first tab on return.
    const persistedClientTabSelections = store?.getMobileClientTabSelections?.()
    if (persistedClientTabSelections) {
      this.clientSessionTabSelections.hydrate(persistedClientTabSelections)
    }
    this.clientSessionTabSelections.setPersistListener((state) => {
      this.store?.setMobileClientTabSelections?.(state)
    })
    this.orchestrationEnvironmentTransport = deps?.orchestrationEnvironmentTransport ?? null
    this.orchestrationFederation = new RuntimeOrchestrationFederation(
      runtime,
      this.orchestrationEnvironmentTransport
    )
    if (stats) {
      this.stats = stats
    }
    this.getAgentStatusSnapshotFn = deps?.getAgentStatusSnapshot ?? null
    this.getAgentStatusSnapshotForPaneFn = deps?.getAgentStatusSnapshotForPane ?? null
    this.structuredAgentStatusSinkFn = deps?.structuredAgentStatusSink ?? null
    this.readObservedAgentStatusPaneIdentityFn =
      deps?.readObservedAgentStatusPaneIdentity ?? (() => ({ kind: 'unobserved' }))
    this.getAgentProviderSessionSnapshotFn =
      deps?.getAgentProviderSessionSnapshot ?? deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionRowsForPaneFn = deps?.getAgentProviderSessionRowsForPane ?? null
    this.attestAgentHookCompatibilityAuthorityFn =
      deps?.attestAgentHookCompatibilityAuthority ?? null
    this.retireAgentHookCompatibilityAuthorityFn =
      deps?.retireAgentHookCompatibilityAuthority ?? null
    this.readHookCliWriterObservationFn = deps?.readHookCliWriterObservation ?? null
    this.checkHookAgentPresenceFn = deps?.checkHookAgentPresence ?? null
    this.reconcileAgentStatusForEndedProcessFn = deps?.reconcileAgentStatusForEndedProcess ?? null
    this.forgetHookAgentExitFn = deps?.forgetHookAgentExit ?? null
    this.dropAgentStatusForRemovedWorktreeFn = deps?.dropAgentStatusForRemovedWorktree ?? null
    this.canRecoverPersistentLocalPtysFn = deps?.canRecoverPersistentLocalPtys ?? (() => true)
    this.getPairedDeviceNameFn = deps?.getPairedDeviceName ?? (() => null)
    // Why: configure the shared AiVault scan cache from a serve-mode-reachable
    // seam so the aiVault.listSessions RPC includes managed-Codex + WSL sessions
    // even on headless `orca serve` hosts where registerCoreHandlers never runs.
    if (deps?.getAdditionalAiVaultCodexHomePaths) {
      configureAiVaultSessionSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
      configureHostReadableTranscriptPathSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
    }
    // Why: the daemon adapter is installed via `setLocalPtyProvider()` during
    // attachMainWindowServices, AFTER this service is constructed. Capturing
    // `getLocalPtyProvider()` at construction time would freeze a reference to
    // the pre-daemon `LocalPtyProvider` and miss the routed adapter. Resolve
    // lazily via thunk so teardown always sees the currently-installed
    // provider (design §4.3 wire-up).
    this.getLocalProviderFn = deps?.getLocalProvider ?? null
    this.onPtyStopped = deps?.onPtyStopped ?? null
    this.onTerminalAgentStatus = deps?.onTerminalAgentStatus ?? null
    this.onTerminalProgramStatusFacet = deps?.onTerminalProgramStatusFacet ?? null
    this.onClaudeTerminalEvidence = deps?.onClaudeTerminalEvidence ?? null
    this.buildAgentHookPtyEnv = deps?.buildAgentHookPtyEnv ?? null
    this.getDesktopWindowStatusFn = deps?.getDesktopWindowStatus ?? (() => 'openable')
    this.prepareAiVaultSessionResumeFn = deps?.prepareAiVaultSessionResume ?? null
    this.prepareCodexStructuredLaunchFn = deps?.prepareCodexStructuredLaunch ?? null
    this.resolveCodexStructuredLaunchHomeFn = deps?.resolveCodexStructuredLaunchHome ?? null
    this.prepareCodexCatalogProbeHomeFn = deps?.prepareCodexCatalogProbeHome ?? null
    this.agentSessionClaimSigner =
      deps?.agentSessionClaimSigner ?? createEphemeralAgentSessionClaimSigner(this.runtimeId)
    this.onTerminalSideEffects = deps?.onTerminalSideEffects ?? null
    // Why: the ConPTY spawn mark can land after daemon stream data already
    // created this PTY's emulator; the mark retrofits the DA1 override here
    // (terminal-query-authority.md §ConPTY DA1).
    registerConptyDa1OverrideInstaller((ptyId) => this.ensureNativeWindowsConptyDa1Override(ptyId))
    // Why: a renderer attribute push must reach already-live emulators too —
    // cursor options for DECRQSS/DECRQM parity plus the per-PTY OSC color
    // override reset a theme apply implies (terminal-query-authority.md
    // §View-attribute bridge).
    registerTerminalViewAttributesApplier((attributes) => {
      for (const state of this.headlessTerminals.values()) {
        state.emulator.applyPushedViewAttributes(attributes)
      }
    })
    // Why: PR conflict previews fetch the same base branches a create refreshes; one owner queues them.
    setPRConflictSummaryRemoteFetches(this.remoteFetches)
  }
}

// oxlint-disable-next-line typescript/consistent-type-definitions -- SAFETY: This merge models the constructor-installed canonical methods.
export interface OrcaRuntimeWithStateFields
  extends
    RuntimeFileCommandSurface,
    RuntimeGitCommandSurface,
    RuntimeRepositoryCommandSurface,
    RuntimeReviewCommandSurface,
    RuntimeServiceCommandSurface,
    RuntimeSkillCommandSurface,
    RuntimeEdgeCommandSurface {}
