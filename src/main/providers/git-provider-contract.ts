import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { AppendGitignoreEntriesResult, GitignoreEntry } from '../../shared/gitignore-entry'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitForkSyncExpectedUpstream,
  GitForkSyncResult,
  GitPushTarget,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus,
  GitWorktreeInfo,
  RemoveWorktreeResult
} from '../../shared/types'
import type { GitProviderStatusOptions } from './git-provider-status-options'

export type IGitProvider = {
  getStatus(worktreePath: string, options?: GitProviderStatusOptions): Promise<GitStatusResult>
  getSubmoduleStatus(
    worktreePath: string,
    submodulePath: string,
    area?: GitStagingArea
  ): Promise<GitStatusResult>
  checkIgnoredPaths(worktreePath: string, relativePaths: string[]): Promise<string[]>
  appendGitignoreEntries(
    worktreePath: string,
    entries: GitignoreEntry[]
  ): Promise<AppendGitignoreEntriesResult>
  getHistory(worktreePath: string, options?: GitHistoryOptions): Promise<GitHistoryResult>
  commit(worktreePath: string, message: string): Promise<{ success: boolean; error?: string }>
  getStagedCommitContext(worktreePath: string): Promise<CommitMessageDraftContext | null>
  getDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean
  ): Promise<GitDiffResult>
  stageFile(worktreePath: string, filePath: string): Promise<void>
  unstageFile(worktreePath: string, filePath: string): Promise<void>
  bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  discardChanges(worktreePath: string, filePath: string): Promise<void>
  bulkDiscardChanges(worktreePath: string, filePaths: string[]): Promise<void>
  detectConflictOperation(worktreePath: string): Promise<GitConflictOperation>
  abortMerge(worktreePath: string): Promise<void>
  abortRebase(worktreePath: string): Promise<void>
  checkoutBranch(worktreePath: string, branch: string): Promise<void>
  listLocalBranches(worktreePath: string): Promise<{ current: string | null; branches: string[] }>
  getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult>
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
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
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
  getRemoteFileUrl(worktreePath: string, relativePath: string, line: number): Promise<string | null>
  getRemoteCommitUrl(worktreePath: string, sha: string): Promise<string | null>
  worktreeIsClean(
    worktreePath: string,
    options?: { includeUntracked?: boolean }
  ): Promise<{ clean: boolean; stdout?: string }>
}
