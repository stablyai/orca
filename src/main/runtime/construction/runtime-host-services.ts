import type * as Calls from './runtime-host-service-calls'
import type { RuntimeConstructionBindings as HostBindings } from './runtime-construction-dependencies'

import type { RuntimeRepositoryCommandSurface } from '../runtime-repository-command-surface'

import type { LegacyWorkerRecoveryCandidate } from '../runtime-legacy-worker-terminal-recovery-types'

import type { LegacyWorkerTerminalRecoveryPlan } from '../orchestration/orchestration-legacy-worker-terminal-recovery'

import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { confirmRunTerminalShellAlone, readRunTerminalClientUse } from '../run-terminal-client-use'
import { ALL_EXECUTION_HOSTS_SCOPE, type ExecutionHostId } from '../../../shared/execution-host'
import { RuntimePreservedBranchCleanup } from '../runtime-preserved-branch-cleanup'
import type {
  AgentSessionCreateOperation,
  OrchestrationCompatibilitySshAttachmentAuthority,
  RestoredOrchestrationAuthorityReceipt
} from '../runtime-terminal-contracts'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'

import type { AgentStatus } from '../../../shared/agent-detection'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from '../runtime-legacy-worker-terminal-recovery-persistence'
import { RuntimeLegacyWorkerTerminalRecoveryController } from '../runtime-legacy-worker-terminal-recovery-controller'
import { reconcileRequestedWorkerTerminalReleases } from '../orchestration/worker-terminal-release-reconciliation'

import { RuntimeAccountController } from '../runtime-account-controller'
import { RuntimeMobileSpeechCatalog } from '../runtime-mobile-speech-catalog'
import { RuntimeMobileDictationController } from '../runtime-mobile-dictation-controller'
import { RuntimeProjectHostSetupController } from '../runtime-project-host-setup-controller'
import { RuntimeProjectGroupController } from '../runtime-project-group-controller'
import { RuntimeNestedRepoImport } from '../runtime-nested-repo-import'
import { RuntimeRepositoryRegistrationController } from '../runtime-repository-registration-controller'
import { RuntimeRepositoryCloneController } from '../runtime-repository-clone-controller'
import { RuntimeRepositorySettingsController } from '../runtime-repository-settings-controller'
import { RuntimeRepositorySparsePresets } from '../runtime-repository-sparse-presets'
import { RuntimeRepositoryRefQueries } from '../runtime-repository-ref-queries'
import { RuntimeServerEnvironmentCommands } from '../runtime-server-environment-commands'
import { RuntimeRepositoryForkBackfill } from '../runtime-repository-fork-backfill'
import { RuntimeWorkspaceSessionController } from '../runtime-workspace-session-controller'
import { RuntimeAiVaultCommands } from '../runtime-ai-vault-commands'
import { ClaudeAgentTeamsService } from '../claude-agent-teams-service'
import { teardownFolderWorkspacePtys } from '../folder-workspace-pty-teardown'
import { countRepoTerminalsNotKnownExited } from '../project-removal-impact'

export abstract class OrcaRuntimeWithPreservedBranchCleanup extends OrcaRuntimeWithTerminalDrivers {
  declare addRepo: RuntimeRepositoryCommandSurface['addRepo']
  declare cloneRepo: RuntimeRepositoryCommandSurface['cloneRepo']
  protected abstract tryGetWorkspaceSessionHostIdForWorktree(
    worktreeId: string
  ): ExecutionHostId | null
  protected abstract getLegacyWorkerRecoveryActivation(
    ...args: Calls.GetLegacyWorkerRecoveryActivationArgs
  ): Calls.GetLegacyWorkerRecoveryActivationResult
  protected abstract hasExactPersistedTerminalSurfaceIdentity(
    ...args: Calls.HasExactPersistedTerminalSurfaceIdentityArgs
  ): Calls.HasExactPersistedTerminalSurfaceIdentityResult
  protected abstract hasExactTerminalSurfaceIdentity(
    ...args: Calls.HasExactTerminalSurfaceIdentityArgs
  ): Calls.HasExactTerminalSurfaceIdentityResult
  protected abstract adoptLegacyWorkerTerminal(
    ...args: Calls.AdoptLegacyWorkerTerminalArgs
  ): Calls.AdoptLegacyWorkerTerminalResult
  protected abstract revealLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate
  ): Promise<boolean | null>
  abstract onPtyExit(...args: Calls.OnPtyExitArgs): Calls.OnPtyExitResult
  protected abstract rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void
  abstract reconcileLegacyWorkerTerminals(
    ...args: Calls.ReconcileLegacyWorkerTerminalsArgs
  ): Calls.ReconcileLegacyWorkerTerminalsResult
  protected abstract updateLegacyWorkerTerminalRecoveryRetry(
    ...args: Calls.UpdateLegacyWorkerTerminalRecoveryRetryArgs
  ): Calls.UpdateLegacyWorkerTerminalRecoveryRetryResult
  protected abstract resolveFolderWorkspaceConnectionId(workspace: FolderWorkspace): string | null

  protected abstract runWorktreeTerminalMutation<T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T>
  protected abstract folderWorkspaceToResolvedWorktree(
    folderWorkspace: FolderWorkspace
  ): ResolvedWorktree

  readonly preservedBranchCleanup = new RuntimePreservedBranchCleanup(() =>
    this.store ? this.requireStore() : null
  )

  protected readonly getLocalProviderFn!: HostBindings['getLocalProvider'] | null

  readonly onPtyStopped!: HostBindings['onPtyStopped'] | null

  protected readonly onTerminalAgentStatus!: HostBindings['onTerminalAgentStatus'] | null

  protected readonly onTerminalProgramStatusFacet!:
    | HostBindings['onTerminalProgramStatusFacet']
    | null

  protected readonly onTerminalSideEffects!: HostBindings['onTerminalSideEffects'] | null

  protected readonly onClaudeTerminalEvidence!: HostBindings['onClaudeTerminalEvidence'] | null

  protected terminalSideEffectLocalConsumerAvailable = false

  protected terminalSideEffectConsumerAvailable = false

  readonly getAgentStatusSnapshotFn!: HostBindings['getAgentStatusSnapshot'] | null

  protected readonly structuredAgentStatusSinkFn!: HostBindings['structuredAgentStatusSink'] | null

  readonly readObservedAgentStatusPaneIdentityFn!: HostBindings['readObservedAgentStatusPaneIdentity']

  protected readonly getAgentProviderSessionSnapshotFn!:
    | HostBindings['getAgentProviderSessionSnapshot']
    | null

  protected readonly getAgentProviderSessionRowsForPaneFn!:
    | HostBindings['getAgentProviderSessionRowsForPane']
    | null

  readTerminalClientUse(ptyId: string): 'used' | 'unused' | 'unknown' {
    return readRunTerminalClientUse(this, ptyId)
  }

  confirmTerminalShellAlone(ptyId: string): Promise<boolean> {
    return confirmRunTerminalShellAlone(this.ptyController, ptyId)
  }

  getTerminalPtyIdForHandle(handle: string): string | null {
    return this.getLivePtyForHandle(handle)?.pty.ptyId ?? null
  }

  /** Includes resume-identity-only provider rows. */
  getAgentProviderSessionRows(): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionSnapshotFn?.() ?? []
  }

  getAgentStatusRowsForPane(paneKey: string): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
  }

  protected readonly attestAgentHookCompatibilityAuthorityFn!:
    | HostBindings['attestAgentHookCompatibilityAuthority']
    | null

  protected readonly retireAgentHookCompatibilityAuthorityFn!:
    | HostBindings['retireAgentHookCompatibilityAuthority']
    | null

  protected readonly checkHookAgentPresenceFn!: HostBindings['checkHookAgentPresence'] | null

  protected readonly reconcileAgentStatusForEndedProcessFn!:
    | HostBindings['reconcileAgentStatusForEndedProcess']
    | null

  protected readonly forgetHookAgentExitFn!: HostBindings['forgetHookAgentExit'] | null

  protected readonly dropAgentStatusForRemovedWorktreeFn!:
    | HostBindings['dropAgentStatusForRemovedWorktree']
    | null

  protected readonly canRecoverPersistentLocalPtysFn!: HostBindings['canRecoverPersistentLocalPtys']

  protected readonly getPairedDeviceNameFn!: HostBindings['getPairedDeviceName']

  protected readonly buildAgentHookPtyEnv!: HostBindings['buildAgentHookPtyEnv'] | null

  protected readonly getDesktopWindowStatusFn!: HostBindings['getDesktopWindowStatus']

  protected readonly prepareAiVaultSessionResumeFn!:
    | HostBindings['prepareAiVaultSessionResume']
    | null

  protected readonly prepareCodexStructuredLaunchFn!:
    | HostBindings['prepareCodexStructuredLaunch']
    | null

  protected readonly resolveCodexStructuredLaunchHomeFn!:
    | HostBindings['resolveCodexStructuredLaunchHome']
    | null

  protected readonly prepareCodexCatalogProbeHomeFn!:
    | HostBindings['prepareCodexCatalogProbeHome']
    | null

  protected readonly agentSessionClaimSigner!: HostBindings['agentSessionClaimSigner']

  protected readonly agentSessionCreateOperations = new Map<string, AgentSessionCreateOperation>()

  protected readonly agentPromptSubmissionTailByPtyId = new Map<string, Promise<void>>()

  protected readonly agentPromptLifecycleByPtyId = new Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >()

  protected readonly agentPromptPermissionSequenceByPtyId = new Map<string, number>()

  protected readonly agentPromptExplicitStatusFloorByPtyId = new Map<string, number>()

  protected readonly orchestrationCompatibilitySshAttachments = new Map<
    string,
    OrchestrationCompatibilitySshAttachmentAuthority
  >()

  protected sshRelayRecoveryGenerationByTargetId = new Map<string, number>()

  protected readonly legacyWorkerRecoveryPersistence =
    new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => this.store,
      () => this.getOrchestrationDb(),
      (worktreeId) => this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    )

  protected readonly legacyWorkerRecovery = new RuntimeLegacyWorkerTerminalRecoveryController({
    preparePlan: (dispatchIds) => this.legacyWorkerRecoveryPersistence.prepare(dispatchIds),
    resolveWorkspace: async (candidate) => {
      const scope = await this.resolveTerminalWorkspaceLaunchScope(`id:${candidate.worktreeId}`)
      const resolved = scope.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(scope.folderWorkspace)
        : await this.resolveGitWorktreeSelector(`id:${scope.id}`)
      return { scope, resolved }
    },
    refreshInventory: (worktrees, connectionId) =>
      this.refreshPtyWorktreeRecordsWithControllerInventory(
        worktrees,
        null,
        undefined,
        connectionId,
        false,
        { includeForegroundProcessEvidence: false, refreshForegroundAgents: false }
      ),
    runMutation: (worktreeId, operation) => this.runWorktreeTerminalMutation(worktreeId, operation),
    getActivation: (worktreeId) => this.getLegacyWorkerRecoveryActivation(worktreeId),
    hasExactPersistedSurface: (candidate) =>
      this.hasExactPersistedTerminalSurfaceIdentity(candidate),
    hasExactSurface: (candidate) => this.hasExactTerminalSurfaceIdentity(candidate),
    adopt: (candidate, workspace, inventory, activation) =>
      this.adoptLegacyWorkerTerminal(candidate, workspace, inventory, activation),
    getRendererEpoch: () => this.rendererGraphEpoch,
    reveal: (candidate) => this.revealLegacyWorkerTerminal(candidate),
    onPtyExit: (candidate) => this.onPtyExit(candidate.ptyId, 0, candidate.incarnationId),
    persist: (resolutions) => this.legacyWorkerRecoveryPersistence.persist(resolutions),
    rollback: (candidate) => this.rollbackLegacyWorkerTerminalSurface(candidate),
    reconcileMissing: (candidate) =>
      this.legacyWorkerRecoveryPersistence.reconcileMissing(candidate),
    notifyResolution: (candidate, resolution) =>
      this.notifier?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, resolution),
    canRecoverPersistentLocalPtys: () => this.canRecoverPersistentLocalPtysFn(),
    isTerminalProvenAbsent: (candidate) => this.isLeafPtyProvenAbsent(candidate.ptyId),
    hasRequestedReleases: () =>
      this.getOrchestrationDb().listWorkerTerminalReleaseBacklog(1).length > 0,
    reconcileRequestedReleases: () => reconcileRequestedWorkerTerminalReleases(this),
    reconcile: (options) => this.reconcileLegacyWorkerTerminals(options),
    updateRetry: (plan, deferredDispatchIds, options) =>
      this.updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
  })

  protected restoredOrchestrationAuthorityByPtyId = new Map<
    string,
    RestoredOrchestrationAuthorityReceipt
  >()

  protected ptyControllerInventorySequence = 0

  protected ptyControllerAggregateInventoryGeneration = 0

  protected ptyControllerInventoryGenerationByProvider = new Map<string, number>()

  protected readonly accounts = new RuntimeAccountController()

  protected readonly mobileSpeech = new RuntimeMobileSpeechCatalog(() => this.store)

  protected readonly mobileDictation = new RuntimeMobileDictationController(() => this.store)

  protected readonly projectHostSetups = new RuntimeProjectHostSetupController({
    getStore: () => this.store,
    listRepos: () => this.listRepos(),
    addRepo: (path, kind, hostId) => this.addRepo(path, kind, hostId),
    cloneRepo: (url, destination, hostId) => this.cloneRepo(url, destination, hostId),
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged(),
    countLiveTerminalsForRepo: (repo) =>
      countRepoTerminalsNotKnownExited(repo, this.ptysById.values(), (ptyId) =>
        this.isPtyKnownExited(ptyId)
      )
  })

  protected readonly projectGroups = new RuntimeProjectGroupController({
    getStore: () => this.store,
    resolveRepo: (...args) => this.managedWorktreeQueries.resolveRepoForConnection(...args),
    notifyReposChanged: () => this.notifyReposChanged(),
    resolveFolderConnectionId: (workspace) => this.resolveFolderWorkspaceConnectionId(workspace),
    teardownFolderWorkspacePtys: (...target) =>
      teardownFolderWorkspacePtys(
        {
          runtime: this,
          getLocalProvider: () => this.getLocalProvider(),
          onPtyStopped: this.onPtyStopped
        },
        ...target
      ),
    cleanupRemovedFolderWorkspaceState: (worktreeId) => {
      if (this.store) {
        this.removeWorktreeMetadataAndHistory(this.store, worktreeId)
      }
      // Folder ids are minted by this store and shared with no other host.
      this.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, ALL_EXECUTION_HOSTS_SCOPE)
    },
    emitWorktreeLifecycle: (event) => this.worktreeLifecycleEvents.emit(event)
  })

  private readonly repositoryCatalogDeps = {
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId: string) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  }

  protected readonly nestedRepoImport = new RuntimeNestedRepoImport(this.repositoryCatalogDeps)

  protected readonly repositoryRegistrations = new RuntimeRepositoryRegistrationController(
    this.repositoryCatalogDeps
  )

  protected readonly repositoryClones = new RuntimeRepositoryCloneController(
    this.repositoryCatalogDeps
  )

  protected readonly repositorySettings = new RuntimeRepositorySettingsController({
    ...this.repositoryCatalogDeps,
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    forgetTerminalTopology: (repoId) => this.terminalTopologyRevisionByRepoId.delete(repoId),
    stopProjectTerminals: (repo, options) => this.stopTerminalsForProject(repo, options),
    notifyWorktreesChanged: (repoId, options) => this.notifyWorktreesChanged(repoId, options)
  })

  protected readonly repositorySparsePresets = new RuntimeRepositorySparsePresets({
    getStore: () => this.store,
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })

  protected readonly repositoryRefQueries = new RuntimeRepositoryRefQueries({
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })

  protected readonly serverEnvironment = new RuntimeServerEnvironmentCommands()

  protected readonly repositoryForkBackfill = new RuntimeRepositoryForkBackfill(
    () => this.store,
    () => this.notifyReposChanged()
  )

  protected readonly workspaceSessions = new RuntimeWorkspaceSessionController({
    getStore: () => this.store,
    resolveFolderConnectionId: (workspace) => this.resolveFolderWorkspaceConnectionId(workspace),
    hasRuntimeOwnedPtyCandidate: (session, worktreeId, tabs) =>
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs),
    getCachedWorktrees: () => this.resolvedWorktrees.peek()?.worktrees ?? null
  })

  protected readonly aiVault = new RuntimeAiVaultCommands(() => this.prepareAiVaultSessionResumeFn)

  protected readonly claudeAgentTeams = new ClaudeAgentTeamsService()

  getNativeChatLaunchDraftResolutionClientEventSnapshot =
    this.nativeChatDraftResolutions.snapshot.bind(this.nativeChatDraftResolutions)

  protected emitClientEvent = this.clientEvents.emit.bind(this.clientEvents)
}
