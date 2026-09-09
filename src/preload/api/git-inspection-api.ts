import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../shared/git-diff-compare-types'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus
} from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../shared/commit-message-agent-spec'
import type { GitBlameResult } from '../../shared/git-blame'
import type { GitStashCreateOptions, GitStashFile, GitStashSummary } from '../../shared/git-stash'

export type GitInspectionApi = {
	blame: (args: {
		worktreePath: string
		relativePath: string
		connectionId?: string
		requestToken?: string
	}) => Promise<GitBlameResult>
	cancelBlame: (args: { requestToken: string }) => Promise<void>
  stashList: (args: { worktreePath: string; connectionId?: string; requestToken?: string }) => Promise<GitStashSummary[]>
  stashFiles: (args: { worktreePath: string; ref: string; connectionId?: string; requestToken?: string }) => Promise<GitStashFile[]>
  stashCancel: (args: { requestToken: string }) => Promise<void>
  stashCreate: (args: { worktreePath: string; connectionId?: string } & GitStashCreateOptions) => Promise<void>
  stashApply: (args: { worktreePath: string; ref: string; connectionId?: string }) => Promise<void>
  stashPop: (args: { worktreePath: string; ref: string; connectionId?: string }) => Promise<void>
  stashDrop: (args: { worktreePath: string; ref: string; connectionId?: string }) => Promise<void>
  status: (args: {
    worktreePath: string
    connectionId?: string
    admissionTier?: 'interactive' | 'status' | 'background'
    includeIgnored?: boolean
    includeLineStats?: boolean
    bypassEffectiveUpstreamNegativeCache?: boolean
    reuseLineStats?: boolean
    /** Merge-base OID to measure the branch line total against; omit to skip the work. */
    branchLineTotalMergeBase?: string
    requestToken?: string
  }) => Promise<GitStatusResult>
  cancelStatus: (args: { requestToken: string }) => Promise<void>
  setStatusUpstreamRefWatch: (args: {
    worktreeId: string
    worktreePath: string
    executionHostId: string
    connectionId?: string
    branch?: string
    upstreamName?: string
  }) => Promise<void>
  submoduleStatus: (args: {
    worktreePath: string
    submodulePath: string
    connectionId?: string
    area?: GitStagingArea
  }) => Promise<GitStatusResult>
  checkIgnored: (args: {
    worktreePath: string
    paths: string[]
    connectionId?: string
  }) => Promise<string[]>
  findHugeFoldersToIgnore: (args: { worktreePath: string }) => Promise<string[]>
  history: (
    args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
  ) => Promise<GitHistoryResult>
  conflictOperation: (args: {
    worktreePath: string
    connectionId?: string
  }) => Promise<GitConflictOperation>
  diff: (args: {
    worktreePath: string
    filePath: string
    staged: boolean
    compareAgainstHead?: boolean
    connectionId?: string
  }) => Promise<GitDiffResult>
  branchCompare: (args: {
    worktreePath: string
    baseRef: string
    connectionId?: string
    admissionTier?: 'interactive' | 'status' | 'background'
  }) => Promise<GitBranchCompareResult>
  commitCompare: (args: {
    worktreePath: string
    commitId: string
    connectionId?: string
  }) => Promise<GitCommitCompareResult>
  upstreamStatus: (args: {
    worktreePath: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }) => Promise<GitUpstreamStatus>
  branchDiff: (args: {
    worktreePath: string
    compare: {
      baseRef: string
      baseOid: string
      headOid: string
      mergeBase: string
    }
    filePath: string
    oldPath?: string
    connectionId?: string
  }) => Promise<GitDiffResult>
  commitDiff: (args: {
    worktreePath: string
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
    connectionId?: string
  }) => Promise<GitDiffResult>
  discoverCommitMessageModels: (args: {
    agentId: string
    worktreePath?: string
    connectionId?: string
  }) => Promise<
    | {
        success: true
        capability: CommitMessageAgentCapability
        models: CommitMessageModelCapability[]
        defaultModelId: string
        catalogOrigin: 'probe' | 'spec'
      }
    | { success: false; error: string }
  >
  remoteFileUrl: (args: {
    worktreePath: string
    relativePath: string
    line: number
    connectionId?: string
  }) => Promise<string | null>
  remoteCommitUrl: (args: {
    worktreePath: string
    sha: string
    connectionId?: string
  }) => Promise<string | null>
}
