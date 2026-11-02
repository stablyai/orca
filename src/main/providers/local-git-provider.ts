import { gitSyncForkDefaultBranch } from '../git/fork-sync'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import { checkoutBranch, listLocalBranches } from '../git/checkout'
import { getHistory } from '../git/history'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from '../git/remote'
import { getRemoteCommitUrl, getRemoteFileUrl, isGitRepo } from '../git/repo'
import { awaitWindowsHostGitEnvironmentReady, gitExecFileAsync } from '../git/runner'
import {
  abortMerge,
  abortRebase,
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  commitChanges,
  completeMerge,
  detectConflictOperation,
  discardChanges,
  getBranchCompare,
  getCommitCompare,
  getCommitDiff,
  getDiff,
  getStagedCommitContext,
  getStatus,
  getSubmoduleStatus,
  resolveConflict,
  stageFile,
  stageWorktreeChanges,
  unstageFile
} from '../git/status'
import { getUpstreamStatus } from '../git/upstream'
import { listWorktrees } from '../git/worktree'
import type { IGitProvider } from './git-provider-contract'

/** Per-worktree execution options; build one provider per call and never cache it (WSL routing). */
export type LocalGitProviderOptions = GitRuntimeOptions & {
  /** Shared symlinks Git cannot ignore. Lazy: only status and stage-all read the repo config. */
  getSharedLinkPaths?: () => readonly string[]
}

/** Methods needing extra local inputs, such as repo paths or pinned diffs, retain their existing call sites. */
export type LocalGitProvider = Omit<
  IGitProvider,
  | 'getBranchDiff'
  | 'addWorktree'
  | 'removeWorktree'
  | 'isGitRepoAsync'
  | 'worktreeIsClean'
  | 'renameCurrentBranch'
  | 'forceDeletePreservedBranch'
>

export function createLocalGitProvider(options: LocalGitProviderOptions = {}): LocalGitProvider {
  const { getSharedLinkPaths = () => [], ...base } = options
  const interactive = { ...base, admissionTier: 'interactive' as const }
  return {
    getStatus: (worktreePath, statusOptions) => {
      // Shared directory symlinks do not match Git directory-only ignore rules.
      const sharedLinkPaths = getSharedLinkPaths()
      return getStatus(worktreePath, {
        ...statusOptions,
        ...base,
        admissionTier: statusOptions?.admissionTier ?? 'status',
        ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
      })
    },
    getSubmoduleStatus: (worktreePath, submodulePath, area = 'unstaged') =>
      getSubmoduleStatus(worktreePath, submodulePath, {
        ...interactive,
        ...(area === 'staged' ? { staged: true } : {})
      }),
    checkIgnoredPaths: (worktreePath, relativePaths) =>
      checkIgnoredPaths(worktreePath, relativePaths, interactive),
    getHistory: (worktreePath, historyOptions = {}) =>
      getHistory(worktreePath, { ...historyOptions, ...interactive }),
    commit: (worktreePath, message) => commitChanges(worktreePath, message, interactive),
    completeMerge: (worktreePath) => completeMerge(worktreePath, interactive),
    getStagedCommitContext: (worktreePath) => getStagedCommitContext(worktreePath, interactive),
    getDiff: (worktreePath, filePath, staged, compareAgainstHead, oldPath) =>
      getDiff(worktreePath, filePath, staged, compareAgainstHead, {
        ...interactive,
        ...(oldPath ? { oldPath } : {})
      }),
    stageFile: (worktreePath, filePath) => stageFile(worktreePath, filePath, interactive),
    resolveConflict: (worktreePath, filePath, resolution) =>
      resolveConflict(worktreePath, filePath, resolution, interactive),
    unstageFile: (worktreePath, filePath) => unstageFile(worktreePath, filePath, interactive),
    bulkStageFiles: async (worktreePath, filePaths, scope) => {
      if (scope) {
        await stageWorktreeChanges(worktreePath, scope, {
          ...interactive,
          sharedLinkPaths: getSharedLinkPaths()
        })
        return
      }
      await bulkStageFiles(worktreePath, filePaths, interactive)
    },
    bulkUnstageFiles: (worktreePath, filePaths) =>
      bulkUnstageFiles(worktreePath, filePaths, interactive),
    discardChanges: (worktreePath, filePath) => discardChanges(worktreePath, filePath, interactive),
    bulkDiscardChanges: (worktreePath, filePaths) =>
      bulkDiscardChanges(worktreePath, filePaths, interactive),
    detectConflictOperation: (worktreePath) => detectConflictOperation(worktreePath, base),
    abortMerge: (worktreePath) => abortMerge(worktreePath, interactive),
    abortRebase: (worktreePath) => abortRebase(worktreePath, interactive),
    checkoutBranch: (worktreePath, branch) => checkoutBranch(worktreePath, branch, interactive),
    listLocalBranches: (worktreePath) => listLocalBranches(worktreePath, base),
    getBranchCompare: (worktreePath, baseRef, compareOptions) =>
      getBranchCompare(worktreePath, baseRef, {
        ...base,
        admissionTier: compareOptions?.admissionTier ?? 'interactive'
      }),
    getCommitCompare: (worktreePath, commitId) =>
      getCommitCompare(worktreePath, commitId, interactive),
    getUpstreamStatus: (worktreePath, pushTarget) =>
      getUpstreamStatus(worktreePath, pushTarget, base),
    pushBranch: (worktreePath, publish, pushTarget, pushOptions) =>
      gitPush(worktreePath, publish === true, pushTarget, {
        forceWithLease: pushOptions?.forceWithLease === true,
        ...interactive
      }),
    pullBranch: (worktreePath, pushTarget) => gitPull(worktreePath, pushTarget, interactive),
    fastForwardBranch: (worktreePath, pushTarget) =>
      gitFastForward(worktreePath, pushTarget, interactive),
    rebaseFromBase: (worktreePath, baseRef) =>
      gitPullRebaseFromBase(worktreePath, baseRef, interactive),
    fetchRemote: (worktreePath, pushTarget) => gitFetch(worktreePath, pushTarget, interactive),
    syncForkDefaultBranch: (worktreePath, expectedUpstream) =>
      gitSyncForkDefaultBranch(worktreePath, expectedUpstream, interactive),
    getCommitDiff: (worktreePath, args) => getCommitDiff(worktreePath, args, interactive),
    listWorktrees: (repoPath, listOptions) =>
      listWorktrees(repoPath, listOptions?.signal ? { ...base, signal: listOptions.signal } : base),
    isGitRepo: (path) => isGitRepo(path),
    exec: (args, cwd, execOptions) =>
      gitExecFileAsync(args, {
        ...base,
        cwd,
        ...(execOptions?.signal ? { signal: execOptions.signal } : {}),
        ...(execOptions?.timeoutMs === undefined ? {} : { timeout: execOptions.timeoutMs })
      }),
    getRemoteFileUrl: async (worktreePath, relativePath, line, endLine) => {
      await awaitWindowsHostGitEnvironmentReady({ ...base, cwd: worktreePath })
      return getRemoteFileUrl(worktreePath, relativePath, line, endLine, base)
    },
    getRemoteCommitUrl: async (worktreePath, sha) => {
      await awaitWindowsHostGitEnvironmentReady({ cwd: worktreePath })
      return getRemoteCommitUrl(worktreePath, sha)
    }
  }
}
