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
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import type {
  HostLineageSnapshot,
  ListDesktopLineageForHostArgs
} from '../../shared/host-lineage-contract'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type {
  AdoptProvisionedRootArgs,
  CreateWorktreeArgs,
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
  Worktree,
  WorktreeHeadIdentity
} from '../../shared/worktree/types'

export type WorktreeApi = {
  list: (args: { repoId: string }) => Promise<Worktree[]>
  /** Generated names already spent in this repo, including deleted workspaces. Name suggestions
   *  exclude these so a recreated workspace never lands on a prior occupant's path. Compacted: a
   *  fully spent tier is reported as the watermark rather than as its 552 names. */
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
  /** Retires the persisted metadata an authoritative scan proved gone, so it stops feeding the read above. */
  forgetRemovedForExecutionHost?: (
    args: ForgetRemovedWorktreesForExecutionHostArgs
  ) => Promise<ForgetRemovedWorktreesForExecutionHostResult>
  cancelListDetected?: (args: { providerRequestId: ProviderRequestId }) => Promise<void>
  listAll: () => Promise<Worktree[]>
  create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
  adoptProvisionedRoot: (args: AdoptProvisionedRootArgs) => Promise<CreateWorktreeResult>
  /** Two-phase progress for a background `create`, correlated by `creationId`. The remote/runtime
   *  create path emits nothing, so the surface falls back to an indeterminate spinner. */
  onCreateProgress: (
    callback: (data: { creationId?: string; phase: 'fetching' | 'creating' }) => void
  ) => () => void
  prefetchCreateBase: (args: { repoId: string; baseBranch?: string }) => Promise<void>
  resolvePrBase: (args: {
    repoId: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }) => Promise<GitHubPrStartPoint | { error: string }>
  /** GitLab parallel of resolvePrBase. For same-project MRs returns
   *  `<remote>/<source_branch>`; for fork MRs fetches
   *  refs/merge-requests/<iid>/head and returns the SHA. */
  resolveMrBase: (args: {
    repoId: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }) => Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  >
  remove: (args: {
    worktreeId: string
    hostId?: ExecutionHostId
    force?: boolean
    // Why (#11960): distinct from `force`, which the plain Delete confirmation
    // already sets to skip the dirty-file prompt. Only an explicit Force Delete
    // may waive the proof that every PTY stopped.
    allowUnverifiedPtyStop?: boolean
    skipArchive?: boolean
    snapshotPruneBatchId?: string
  }) => Promise<RemoveWorktreeResult>
  // Forget a workspace from Orca only (no remote Git/FS work) — for workspaces pinned to a removed/disconnected SSH host.
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
  }) => Promise<Worktree>
  listLineage: () => Promise<{
    lineage: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
  }>
  listLineageForHost?: (args: ListDesktopLineageForHostArgs) => Promise<HostLineageSnapshot>
  updateLineage: (args: {
    worktreeId: string
    parentWorktreeId?: string
    noParent?: boolean
  }) => Promise<WorktreeLineage | null>
  persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
  /** Full CLI output of the last branch auto-rename generation failure, held
   *  in main memory only — null after a restart or once the failure clears. */
  getBranchRenameFailureOutput: (args: { worktreeId: string }) => Promise<string | null>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
  onGitStatusMetadataChanged: (callback: (data: { repoId: string }) => void) => () => void
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
