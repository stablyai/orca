// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTerminalDrivers } from './orca-runtime-terminal-drivers'
import { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import type { IPtyProvider } from '../providers/types'
import type {
  AgentSessionCreateOperation,
  OrchestrationCompatibilitySshAttachmentAuthority,
  RestoredOrchestrationAuthorityReceipt,
  RuntimeTerminalAgentStatusEvent
} from './runtime-terminal-contracts'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentHookAuthorityAttestation } from '../agent-hooks/server'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { AgentSessionClaimSigner } from './agent-session-claim-identity'
import type { AgentStatus } from '../../shared/agent-detection'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import { reconcileRequestedWorkerTerminalReleases } from './orchestration/worker-terminal-release-reconciliation'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { RuntimeAccountController } from './runtime-account-controller'
import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { addRemoteRepoFromPath } from '../ipc/repos/remote-repo-registration'
import type { Store } from '../persistence'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import { RuntimeNestedRepoImport } from './runtime-nested-repo-import'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'
import { RuntimeRepositorySparsePresets } from './runtime-repository-sparse-presets'
import { RuntimeRepositoryRefQueries } from './runtime-repository-ref-queries'
import { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'
import { RuntimeRepositoryForkBackfill } from './runtime-repository-fork-backfill'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import { teardownFolderWorkspacePtys } from './folder-workspace-pty-teardown'

export class OrcaRuntimeWithPreservedBranchCleanup extends OrcaRuntimeWithTerminalDrivers {
  protected readonly preservedBranchCleanup = new RuntimePreservedBranchCleanup(() =>
    this.store ? this.requireStore() : null
  )

  protected readonly getLocalProviderFn: (() => IPtyProvider) | null

  protected readonly getSshProviderFn: ((connectionId: string) => IPtyProvider | undefined) | null

  protected readonly onPtyStopped: ((ptyId: string) => void) | null

  protected readonly onTerminalAgentStatus:
    | ((event: RuntimeTerminalAgentStatusEvent) => void)
    | null

  protected readonly onTerminalSideEffects: ((batch: TerminalSideEffectBatch) => void) | null

  protected terminalSideEffectLocalConsumerAvailable = false

  protected terminalSideEffectConsumerAvailable = false

  protected readonly getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null

  protected readonly getAgentProviderSessionSnapshotFn: (() => AgentStatusIpcPayload[]) | null

  protected readonly getAgentProviderSessionRowsForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null

  protected readonly attestAgentHookCompatibilityAuthorityFn:
    | ((candidate: {
        paneKey: string
        launchTokenHash: string
        connectionId: string | null
        terminalProvenance: 'current_runtime' | 'restored'
      }) => AgentHookAuthorityAttestation | null)
    | null

  protected readonly retireAgentHookCompatibilityAuthorityFn: ((paneKey: string) => void) | null

  protected readonly reconcileAgentStatusForEndedProcessFn:
    | ((paneKeys: Iterable<string>) => void)
    | null

  protected readonly canRecoverPersistentLocalPtysFn: () => boolean

  protected readonly getPairedDeviceNameFn: (pairedDeviceId: string) => string | null

  protected readonly buildAgentHookPtyEnv: (() => Record<string, string>) | null

  protected readonly getDesktopWindowStatusFn: () => RuntimeDesktopWindowStatus

  protected readonly prepareAiVaultSessionResumeFn:
    | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
    | null

  protected readonly prepareCodexStructuredLaunchFn:
    | ((input: {
        workspacePath: string
        launchEnv: NodeJS.ProcessEnv
      }) => string | null | Promise<string | null>)
    | null

  protected readonly agentSessionClaimSigner: AgentSessionClaimSigner

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
    preparePlan: () => this.legacyWorkerRecoveryPersistence.prepare(),
    resolveWorkspace: async (candidate) => {
      const scope = await this.resolveTerminalWorkspaceLaunchScope(`id:${candidate.worktreeId}`)
      const resolved = scope.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(scope.folderWorkspace)
        : await this.resolveWorktreeSelector(`id:${scope.id}`)
      return { scope, resolved }
    },
    refreshInventory: (worktrees, connectionId) =>
      this.refreshPtyWorktreeRecordsWithControllerInventory(
        worktrees,
        null,
        undefined,
        connectionId
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
    reconcileRequestedReleases: () =>
      reconcileRequestedWorkerTerminalReleases(this as RuntimeCommandSurfaceHost<this>),
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
    addRepo: (path, kind, hostId) =>
      (this as RuntimeCommandSurfaceHost<this>).addRepo(path, kind, hostId),
    addRemoteRepo: async (remote) => {
      // The same registration the desktop IPC handler uses, so both surfaces agree on SSH hosts.
      const result = await addRemoteRepoFromPath(this.requireStore() as unknown as Store, remote)
      if ('error' in result) {
        throw new Error(result.error)
      }
      this.invalidateResolvedWorktreeCache()
      this.invalidateWorktreeScanCacheForRepo(result.repo.id)
      this.notifyReposChanged()
      return result.repo
    },
    cloneRepo: (url, destination, hostId) =>
      (this as RuntimeCommandSurfaceHost<this>).cloneRepo(url, destination, hostId),
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })

  protected readonly projectGroups = new RuntimeProjectGroupController({
    getStore: () => this.store,
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    notifyReposChanged: () => this.notifyReposChanged(),
    resolveFolderConnectionId: (workspace) => this.resolveFolderWorkspaceConnectionId(workspace),
    teardownFolderWorkspacePtys: (worktreeId, connectionId) =>
      teardownFolderWorkspacePtys(
        {
          runtime: this,
          getSshProvider: this.getSshProviderFn,
          getLocalProvider: () => this.getLocalProvider(),
          onPtyStopped: this.onPtyStopped
        },
        worktreeId,
        connectionId
      ),
    cleanupRemovedFolderWorkspaceState: (worktreeId) => {
      if (this.store) {
        this.removeWorktreeMetadataAndHistory(this.store, worktreeId)
      }
    }
  })

  protected readonly nestedRepoImport = new RuntimeNestedRepoImport({
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })

  protected readonly repositoryRegistrations = new RuntimeRepositoryRegistrationController({
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })

  protected readonly repositoryClones = new RuntimeRepositoryCloneController({
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })

  protected readonly repositorySettings = new RuntimeRepositorySettingsController({
    getStore: () => this.store,
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    forgetTerminalTopology: (repoId) => this.terminalTopologyRevisionByRepoId.delete(repoId),
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
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
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs)
  })

  protected readonly aiVault = new RuntimeAiVaultCommands(() => this.prepareAiVaultSessionResumeFn)

  protected readonly claudeAgentTeams = new ClaudeAgentTeamsService()

  getNativeChatLaunchDraftResolutionClientEventSnapshot =
    this.nativeChatDraftResolutions.snapshot.bind(this.nativeChatDraftResolutions)

  protected emitClientEvent = this.clientEvents.emit.bind(this.clientEvents)
}
