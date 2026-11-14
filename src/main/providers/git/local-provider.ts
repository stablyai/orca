import { createBranch } from '../../git/worktrees/checkout/create-branch'
import { applyCommit, recoverSequencer } from '../../git/worktrees/checkout/commit-actions'
import { gitSyncForkDefaultBranch } from '../../git/remotes/fork-sync'
import type { GitRuntimeOptions } from '../../git/command-runner/git-runtime-options'
import { checkIgnoredPaths } from '../../git/source-control/ignores/check-ignored-paths'
import { checkoutBranch, listLocalBranches } from '../../git/worktrees/checkout/checkout'
import { getHistory, getHistoryRefs } from '../../git/source-control/history'
import { gitFastForward, gitFetch, gitPull, gitPush } from '../../git/remotes/remote'
import { gitPullRebaseFromBase } from '../../git/remotes/remote-rebase'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../../git/remotes/repo-remote-queries'
import { isGitRepo } from '../../git/repositories/discovery/repo-detection'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/command-runner/host-routing/windows-host-git-environment'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import {
  abortMerge,
  abortRebase,
  detectConflictOperation
} from '../../git/source-control/mutations/git-conflict-operation'
import {
  bulkDiscardChanges,
  discardChanges
} from '../../git/source-control/mutations/discard-changes'
import {
  bulkStageFiles,
  bulkUnstageFiles,
  resolveConflict,
  stageFile,
  stageWorktreeChanges,
  unstageFile
} from '../../git/source-control/mutations/staging'
import { commitChanges, completeMerge } from '../../git/source-control/mutations/commit-changes'
import { getBranchCompare } from '../../git/source-control/comparisons/branch-compare'
import { getCommitCompare } from '../../git/source-control/comparisons/commit-compare'
import { getCommitDiff } from '../../git/source-control/comparisons/commit-diff'
import { getDiff } from '../../git/source-control/diffs/file-diff'
import { getStagedCommitContext } from '../../git/source-control/mutations/staged-commit-context'
import { getStatus } from '../../git/source-control/status/status-read'
import { getSubmoduleStatus } from '../../git/source-control/submodules/submodule-status'
import { getUpstreamStatus } from '../../git/source-control/upstream/upstream'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import type { IGitProvider } from './provider-contract'

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
    getHistoryRefs: (worktreePath, query) => getHistoryRefs(worktreePath, query, interactive),
    getHistory: (worktreePath, historyOptions = {}) =>
      getHistory(worktreePath, { ...historyOptions, ...interactive }),
    commit: (worktreePath, message) => commitChanges(worktreePath, message, interactive),
    createBranch: (worktreePath, name, startPoint) =>
      createBranch(worktreePath, name, startPoint, interactive),
    applyCommit: (worktreePath, operation, commitId) =>
      applyCommit(worktreePath, operation, commitId, interactive),
    recoverSequencer: (worktreePath, operation, action) =>
      recoverSequencer(worktreePath, operation, action, interactive),
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
    checkoutBranch: (worktreePath, branch, creation, detached) =>
      checkoutBranch(
        worktreePath,
        branch,
        { ...interactive, ...(detached ? { detached } : {}) },
        creation
      ),
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
