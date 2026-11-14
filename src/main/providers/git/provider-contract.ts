import type {
  GitCommitAction,
  GitCommitActionResult
} from '../../../shared/git/commands/git-commit-action'
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../../shared/git/diff/git-diff-compare-types'
import type {
  GitForkSyncExpectedUpstream,
  GitForkSyncResult
} from '../../../shared/git/remotes/git-fork-sync'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../shared/git/status/git-status-types'
import type { GitStageWorktreeScope } from '../../../shared/git/paths/git-stage-worktree-scope'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../shared/worktree/types'
import type {
  GitHistoryItemRef,
  GitHistoryOptions,
  GitHistoryResult
} from '../../../shared/git/history/git-history-types'
import type { CommitMessageDraftContext } from '../../../shared/source-control/ai/generation/commit-message-generation'
import type { ConflictResolution } from '../../../shared/source-control/listing/source-control-entry-actions'
import type { GitProviderStatusOptions } from './status-options'
import type { BranchSwitchCreation } from '../../../shared/git/branch-switch-target'
import type { RuntimeGitLocalBranches } from '../../../shared/runtime-worktree-contracts'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'

export type IGitProvider = {
  getStatus(worktreePath: string, options?: GitProviderStatusOptions): Promise<GitStatusResult>
  getSubmoduleStatus(
    worktreePath: string,
    submodulePath: string,
    area?: GitStagingArea
  ): Promise<GitStatusResult>
  checkIgnoredPaths(worktreePath: string, relativePaths: string[]): Promise<string[]>
  getHistoryRefs(worktreePath: string, query?: string): Promise<GitHistoryItemRef[]>
  getHistory(worktreePath: string, options?: GitHistoryOptions): Promise<GitHistoryResult>
  commit(worktreePath: string, message: string): Promise<{ success: boolean; error?: string }>
  createBranch(
    worktreePath: string,
    name: string,
    startPoint: string
  ): Promise<GitCommitActionResult>
  applyCommit(
    worktreePath: string,
    operation: GitCommitAction,
    commitId: string
  ): Promise<GitCommitActionResult>
  recoverSequencer(
    worktreePath: string,
    operation: GitCommitAction,
    action: 'abort' | 'continue'
  ): Promise<GitCommitActionResult | void>
  completeMerge(worktreePath: string): Promise<{ success: boolean; error?: string }>
  getStagedCommitContext(worktreePath: string): Promise<CommitMessageDraftContext | null>
  getDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean,
    oldPath?: string
  ): Promise<GitDiffResult>
  stageFile(worktreePath: string, filePath: string): Promise<void>
  resolveConflict(
    worktreePath: string,
    filePath: string,
    resolution: ConflictResolution
  ): Promise<void>
  unstageFile(worktreePath: string, filePath: string): Promise<void>
  bulkStageFiles(
    worktreePath: string,
    filePaths: string[],
    scope?: GitStageWorktreeScope
  ): Promise<void>
  bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  discardChanges(worktreePath: string, filePath: string): Promise<void>
  bulkDiscardChanges(worktreePath: string, filePaths: string[]): Promise<void>
  detectConflictOperation(worktreePath: string): Promise<GitConflictOperation>
  abortMerge(worktreePath: string): Promise<void>
  abortRebase(worktreePath: string): Promise<void>
  /** `skippedPaths`: files git could not replace (held open on Windows) though the switch landed. */
  checkoutBranch(
    worktreePath: string,
    branch: string,
    creation?: BranchSwitchCreation,
    detached?: boolean
  ): Promise<{ skippedPaths: string[] }>
  listLocalBranches(worktreePath: string): Promise<RuntimeGitLocalBranches>
  getBranchCompare(
    worktreePath: string,
    baseRef: string,
    options?: { admissionTier?: GitAdmissionTier }
  ): Promise<GitBranchCompareResult>
  getCommitCompare(worktreePath: string, commitId: string): Promise<GitCommitCompareResult>
  getUpstreamStatus(worktreePath: string, pushTarget?: GitPushTarget): Promise<GitUpstreamStatus>
  pushBranch(
    worktreePath: string,
    publish?: boolean,
    pushTarget?: GitPushTarget,
    options?: { forceWithLease?: boolean }
  ): Promise<void>
  pullBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  fastForwardBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  rebaseFromBase(worktreePath: string, baseRef: string): Promise<void>
  fetchRemote(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  syncForkDefaultBranch(
    worktreePath: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitForkSyncResult>
  getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string; headOid?: string }
  ): Promise<GitDiffResult[]>
  getCommitDiff(
    worktreePath: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string }
  ): Promise<GitDiffResult>
  listWorktrees(repoPath: string, options?: { signal?: AbortSignal }): Promise<GitWorktreeInfo[]>
  addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; checkoutExistingBranch?: boolean; noCheckout?: boolean }
  ): Promise<void>
  removeWorktree(
    worktreePath: string,
    force?: boolean,
    options?: { deleteBranch?: boolean; forceBranchDelete?: boolean }
  ): Promise<RemoveWorktreeResult>
  renameCurrentBranch?(worktreePath: string, newBranch: string): Promise<void>
  forceDeletePreservedBranch?(
    repoPath: string,
    branchName: string,
    expectedHead: string
  ): Promise<void>
  isGitRepo(path: string): boolean
  isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }>
  exec(
    args: string[],
    cwd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string }>
  getRemoteFileUrl(
    worktreePath: string,
    relativePath: string,
    line: number,
    endLine?: number
  ): Promise<string | null>
  getRemoteCommitUrl(worktreePath: string, sha: string): Promise<string | null>
  worktreeIsClean(
    worktreePath: string,
    options?: { includeUntracked?: boolean }
  ): Promise<{ clean: boolean; stdout?: string }>
}
