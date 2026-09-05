import { defineMethod, type RpcMethod } from '../core'
import { GIT_COMMIT_MESSAGE_GENERATION_METHODS } from './git-commit-message-generation-methods'
import { GIT_DIFF_METHODS } from './git-diff-methods'
import {
  GitBranchCompare,
  GitBulkPaths,
  GitCheckIgnored,
  GitCheckout,
  GitCommit,
  GitCommitCompare,
  GitFilePath,
  GitForkSync,
  GitHistory,
  GitPush,
  GitRebaseFromBase,
  GitRemoteCommitUrl,
  GitRemoteFileUrl,
  GitStatusParams,
  GitSubmoduleStatus,
  GitTargetedRemote,
  WorktreeSelector
} from './git-params'

export const GIT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'git.status',
    params: GitStatusParams,
    handler: async (params, { runtime, signal }) => {
      const options =
        params.includeIgnored === undefined &&
        params.includeLineStats === undefined &&
        params.bypassEffectiveUpstreamNegativeCache === undefined &&
        params.reuseLineStats === undefined &&
        params.branchLineTotalMergeBase === undefined &&
        params.admissionTier === undefined &&
        signal === undefined
          ? undefined
          : {
              ...(params.includeIgnored === undefined
                ? {}
                : { includeIgnored: params.includeIgnored }),
              ...(params.includeLineStats === undefined
                ? {}
                : { includeLineStats: params.includeLineStats }),
              ...(params.bypassEffectiveUpstreamNegativeCache === true
                ? { bypassEffectiveUpstreamNegativeCache: true }
                : {}),
              ...(params.reuseLineStats === true ? { reuseLineStats: true } : {}),
              ...(params.branchLineTotalMergeBase === undefined
                ? {}
                : { branchLineTotalMergeBase: params.branchLineTotalMergeBase }),
              admissionTier: params.admissionTier ?? 'status',
              ...(signal ? { signal } : {})
            }
      return options === undefined
        ? runtime.getRuntimeGitStatus(params.worktree, { admissionTier: 'status' })
        : runtime.getRuntimeGitStatus(params.worktree, options)
    }
  }),
  defineMethod({
    name: 'git.checkIgnored',
    params: GitCheckIgnored,
    handler: async (params, { runtime }) =>
      runtime.checkRuntimeGitIgnoredPaths(params.worktree, params.paths)
  }),
  defineMethod({
    name: 'git.submoduleStatus',
    params: GitSubmoduleStatus,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitSubmoduleStatus(params.worktree, params.submodulePath, params.area)
  }),
  defineMethod({
    name: 'git.history',
    params: GitHistory,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitHistory(params.worktree, {
        limit: params.limit,
        baseRef: params.baseRef
      })
  }),
  defineMethod({
    name: 'git.conflictOperation',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.getRuntimeGitConflictOperation(params.worktree)
  }),
  defineMethod({
    name: 'git.abortMerge',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.abortRuntimeGitMerge(params.worktree)
  }),
  defineMethod({
    name: 'git.abortRebase',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.abortRuntimeGitRebase(params.worktree)
  }),
  defineMethod({
    name: 'git.checkout',
    params: GitCheckout,
    handler: async (params, { runtime }) =>
      runtime.checkoutRuntimeGitBranch(params.worktree, params.branch)
  }),
  defineMethod({
    name: 'git.localBranches',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listRuntimeGitLocalBranches(params.worktree)
  }),
  ...GIT_DIFF_METHODS,
  defineMethod({
    name: 'git.branchCompare',
    params: GitBranchCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitBranchCompare(params.worktree, params.baseRef, params.admissionTier)
  }),
  defineMethod({
    name: 'git.commitCompare',
    params: GitCommitCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitCommitCompare(params.worktree, params.commitId)
  }),
  defineMethod({
    name: 'git.upstreamStatus',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.getRuntimeGitUpstreamStatus(params.worktree)
        : runtime.getRuntimeGitUpstreamStatus(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.fetch',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.fetchRuntimeGit(params.worktree)
        : runtime.fetchRuntimeGit(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.forkSync',
    params: GitForkSync,
    handler: async (params, { runtime }) =>
      runtime.syncRuntimeGitForkDefaultBranch(params.worktree, params.expectedUpstream)
  }),
  defineMethod({
    name: 'git.pull',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.pullRuntimeGit(params.worktree)
        : runtime.pullRuntimeGit(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.fastForward',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.fastForwardRuntimeGit(params.worktree)
        : runtime.fastForwardRuntimeGit(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.rebaseFromBase',
    params: GitRebaseFromBase,
    handler: async (params, { runtime }) =>
      runtime.rebaseRuntimeGitFromBase(params.worktree, params.baseRef)
  }),
  defineMethod({
    name: 'git.push',
    params: GitPush,
    handler: async (params, { runtime }) =>
      runtime.pushRuntimeGit(
        params.worktree,
        params.publish,
        params.pushTarget,
        params.forceWithLease
      )
  }),
  defineMethod({
    name: 'git.commit',
    params: GitCommit,
    handler: async (params, { runtime }) =>
      runtime.commitRuntimeGit(params.worktree, params.message)
  }),
  ...GIT_COMMIT_MESSAGE_GENERATION_METHODS,
  defineMethod({
    name: 'git.stage',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.stageRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkStage',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkStageRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.unstage',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.unstageRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkUnstage',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkUnstageRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.discard',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.discardRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkDiscard',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkDiscardRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.remoteFileUrl',
    params: GitRemoteFileUrl,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitRemoteFileUrl(params.worktree, params.relativePath, params.line)
  }),
  defineMethod({
    name: 'git.remoteCommitUrl',
    params: GitRemoteCommitUrl,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitRemoteCommitUrl(params.worktree, params.sha)
  })
]
