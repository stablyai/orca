import type {
  ForgetRemovedWorktreesForExecutionHostArgs,
  ForgetRemovedWorktreesForExecutionHostResult,
  HostQualifiedDetectedWorktreeResult,
  HostQualifiedKnownWorktreeResult,
  LegacyDetectedWorktreeRequest,
  ListDetectedWorktreesArgs,
  ListKnownWorktreesForExecutionHostArgs,
  ProviderRequestId
} from '../../shared/detected-worktree-provider-contract'
import type { NestedWorktreeRemovalApproval } from '../../shared/worktree/nested-removal'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSleepOutcome, WorkspaceSleepRequest } from '../../shared/workspace-sleep'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type {
  AdoptProvisionedRootArgs,
  CreateWorktreeArgs,
  CreateWorktreeProgressEvent,
  CreateWorktreeResult,
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult,
  SparsePreset
} from '../../shared/worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  DetectedWorktreeListResult,
  GitHubPrStartPoint,
  GitPushTarget,
  GitStatusMetadataChangedEvent,
  GitWorktreeInfo,
  Worktree,
  WorktreeHeadIdentity
} from '../../shared/worktree/types'

export type WorktreeApi = {
  /** Retired names prevent path reuse; fully spent tiers are compacted into a watermark. */
  listRetiredNames: (args: { repoId: string }) => Promise<RetiredNameRegistry>
  listDetected: {
    (
      args: ListDetectedWorktreesArgs
    ): Promise<HostQualifiedDetectedWorktreeResult | DetectedWorktreeListResult>
    (args: LegacyDetectedWorktreeRequest): Promise<DetectedWorktreeListResult>
  }
  listKnownForExecutionHost?: (
    args: ListKnownWorktreesForExecutionHostArgs
  ) => Promise<HostQualifiedKnownWorktreeResult>
  /** Retire metadata only after an authoritative scan proves the workspace is gone. */
  forgetRemovedForExecutionHost?: (
    args: ForgetRemovedWorktreesForExecutionHostArgs
  ) => Promise<ForgetRemovedWorktreesForExecutionHostResult>
  cancelListDetected?: (args: { providerRequestId: ProviderRequestId }) => Promise<void>
  create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
  adoptProvisionedRoot: (args: AdoptProvisionedRootArgs) => Promise<CreateWorktreeResult>
  /** Local creates report progress by creationId; remote/runtime creates emit nothing. */
  onCreateProgress: (callback: (data: CreateWorktreeProgressEvent) => void) => () => void
  prefetchCreateBase: (args: { repoId: string; baseBranch?: string }) => Promise<void>
  resolvePrBase: (args: {
    repoId: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }) => Promise<GitHubPrStartPoint | { error: string }>
  /** Same-project MRs return a remote branch; forks fetch the MR head ref and return its SHA. */
  resolveMrBase: (args: {
    repoId: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }) => Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  >
  previewNestedRemoval?: (args: {
    worktreeId: string
    hostId?: ExecutionHostId
  }) => Promise<GitWorktreeInfo[]>
  sleep: (request: WorkspaceSleepRequest) => Promise<WorkspaceSleepOutcome[]>
  sleepReopened: (worktreeId: string) => Promise<void>
  /** True once running, so the renderer's subsequent spawn reattaches. */
  resumeSleptPane: (pane: { worktreeId: string; tabId: string; leafId: string }) => Promise<boolean>
  remove: (args: {
    worktreeId: string
    hostId?: ExecutionHostId
    force?: boolean
    approvedNestedWorktrees?: NestedWorktreeRemovalApproval[]
    // Only explicit Force Delete waives PTY-stop proof; force merely skips dirty-file prompts.
    allowUnverifiedPtyStop?: boolean
    skipArchive?: boolean
    // Waives a failed hook, unlike skipArchive; force does not imply this approval.
    allowFailedArchiveHook?: boolean
    snapshotPruneBatchId?: string
  }) => Promise<RemoveWorktreeResult>
  // Forget local metadata without remote Git/FS work, even when the SSH host is unavailable.
  forgetLocal: (args: {
    worktreeId: string
    hostId?: ExecutionHostId
    snapshotPruneBatchId?: string
  }) => Promise<RemoveWorktreeResult>
  forceDeletePreservedBranch: (args: {
    worktreeId: string
    branchName: string
    expectedHead: string
    hostId?: ExecutionHostId
  }) => Promise<ForceDeleteWorktreeBranchResult>
  updateMeta: (args: {
    worktreeId: string
    executionHostId?: ExecutionHostId
    updates: Partial<WorktreeMeta>
  }) => Promise<Worktree | null>
  listLineage: () => Promise<{
    lineage: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
  }>
  updateLineage: (args: {
    worktreeId: string
    parentWorktreeId?: string
    noParent?: boolean
  }) => Promise<WorktreeLineage | null>
  persistSortOrder: (args: { orderedIds: string[]; hostIds?: string[] }) => Promise<void>
  /** Last failure output; memory-only, cleared on restart or when the failure clears. */
  getBranchRenameFailureOutput: (args: { worktreeId: string }) => Promise<string | null>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
  onGitStatusMetadataChanged: (
    callback: (data: GitStatusMetadataChangedEvent) => void
  ) => () => void
  onHeadIdentitiesChanged: (
    callback: (data: { repoId: string; identities: WorktreeHeadIdentity[] }) => void
  ) => () => void
  onBaseStatus: (callback: (data: WorktreeBaseStatusEvent) => void) => () => void
  onRemoteBranchConflict: (
    callback: (data: WorktreeRemoteBranchConflictEvent) => void
  ) => () => void
}

export type FolderWorkspacesApi = {
  list: () => Promise<FolderWorkspace[]>
  getPathStatus: (args: FolderWorkspacePathStatusRequest) => Promise<FolderWorkspacePathStatus>
  create: (args: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
    linkedTask?: FolderWorkspace['linkedTask']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }) => Promise<FolderWorkspace>
  update: (args: {
    folderWorkspaceId: string
    updates: Partial<
      Pick<
        FolderWorkspace,
        | 'name'
        | 'folderPath'
        | 'linkedTask'
        | 'comment'
        | 'isArchived'
        | 'isUnread'
        | 'isPinned'
        | 'sortOrder'
        | 'manualOrder'
        | 'workspaceStatus'
        | 'createdWithAgent'
        | 'pendingFirstAgentMessageRename'
        | 'firstAgentMessageRenameError'
        | 'lastActivityAt'
        | 'diffComments'
      >
    >
  }) => Promise<FolderWorkspace | null>
  delete: (args: { folderWorkspaceId: string }) => Promise<boolean>
}

export type SparsePresetsApi = {
  list: (args: { repoId: string }) => Promise<SparsePreset[]>
  save: (args: {
    repoId: string
    id?: string
    name: string
    directories: string[]
  }) => Promise<SparsePreset>
  remove: (args: { repoId: string; presetId: string }) => Promise<void>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
}
