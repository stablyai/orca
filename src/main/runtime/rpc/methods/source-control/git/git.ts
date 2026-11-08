import { GIT_STATUS_METHODS } from './git-status-methods'
import { GIT_COMMIT_ACTION_METHODS } from './git-commit-action-methods'
import { defineMethod } from '../../../core'
import { GIT_COMMIT_MESSAGE_GENERATION_METHODS } from './git-commit-message-generation-methods'
import { GIT_BRANCH_METHODS } from './git-branch-methods'
import { GIT_DIFF_METHODS } from './git-diff-methods'
import {
  GitBranchCompare,
  GitBulkPaths,
  GitBulkStage,
  GitCheckIgnored,
  GitCheckout,
  GitCommit,
  GitCommitCompare,
  GitFilePath,
  GitResolveConflict,
  GitForkSync,
  GitHistory,
  GitRefs,
  GitPush,
  GitRebaseFromBase,
  GitRemoteCommitUrl,
  GitRemoteFileUrl,
  GitTargetedRemote,
  WorktreeSelector
} from '../../../../../../shared/rpc-contract/git-params'

export const GIT_METHODS = [
  ...GIT_STATUS_METHODS,
  defineMethod({
    name: 'git.checkIgnored',
    permission: 'workspace',
    params: GitCheckIgnored,
    handler: async (params, { runtime }) =>
      runtime.checkRuntimeGitIgnoredPaths(params.worktree, params.paths)
  }),
  defineMethod({
    name: 'git.refs',
    permission: 'workspace',
    params: GitRefs,
    handler: async (params, { runtime }) => runtime.getRuntimeGitRefs(params.worktree, params.query)
  }),
  defineMethod({
    name: 'git.history',
    permission: 'workspace',
    params: GitHistory,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitHistory(params.worktree, {
        limit: params.limit,
        baseRef: params.baseRef,
        branchOnly: params.branchOnly,
        refs: params.refs,
        historyToken: params.historyToken,
        skip: params.skip
      })
  }),
  defineMethod({
    name: 'git.mutationInFlight',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.getRuntimeGitMutationInFlight(params.worktree)
  }),
  defineMethod({
    name: 'git.abortMerge',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.abortRuntimeGitMerge(params.worktree)
  }),
  defineMethod({
    name: 'git.completeMerge',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.completeRuntimeGitMerge(params.worktree)
  }),
  defineMethod({
    name: 'git.abortRebase',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.abortRuntimeGitRebase(params.worktree)
  }),
  ...GIT_COMMIT_ACTION_METHODS,
  defineMethod({
    name: 'git.checkout',
    permission: 'workspace',
    params: GitCheckout,
    handler: async (params, { runtime }) =>
      runtime.checkoutRuntimeGitBranch(params.worktree, params.branch, params.detached)
  }),
  defineMethod({
    name: 'git.localBranches',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listRuntimeGitLocalBranches(params.worktree)
  }),
  ...GIT_BRANCH_METHODS,
  ...GIT_DIFF_METHODS,
  defineMethod({
    name: 'git.branchCompare',
    permission: 'workspace',
    params: GitBranchCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitBranchCompare(params.worktree, params.baseRef, params.admissionTier)
  }),
  defineMethod({
    name: 'git.commitCompare',
    permission: 'workspace',
    params: GitCommitCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitCommitCompare(params.worktree, params.commitId)
  }),
  defineMethod({
    name: 'git.upstreamStatus',
    permission: 'workspace',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.getRuntimeGitUpstreamStatus(params.worktree)
        : runtime.getRuntimeGitUpstreamStatus(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.fetch',
    permission: 'workspace',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.fetchRuntimeGit(params.worktree)
        : runtime.fetchRuntimeGit(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.forkSync',
    permission: 'workspace',
    params: GitForkSync,
    handler: async (params, { runtime }) =>
      runtime.syncRuntimeGitForkDefaultBranch(params.worktree, params.expectedUpstream)
  }),
  defineMethod({
    name: 'git.pull',
    permission: 'workspace',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.pullRuntimeGit(params.worktree)
        : runtime.pullRuntimeGit(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.fastForward',
    permission: 'workspace',
    params: GitTargetedRemote,
    handler: async (params, { runtime }) =>
      params.pushTarget === undefined
        ? runtime.fastForwardRuntimeGit(params.worktree)
        : runtime.fastForwardRuntimeGit(params.worktree, params.pushTarget)
  }),
  defineMethod({
    name: 'git.rebaseFromBase',
    permission: 'workspace',
    params: GitRebaseFromBase,
    handler: async (params, { runtime }) =>
      runtime.rebaseRuntimeGitFromBase(params.worktree, params.baseRef)
  }),
  defineMethod({
    name: 'git.push',
    permission: 'workspace',
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
    permission: 'workspace',
    params: GitCommit,
    handler: async (params, { runtime }) =>
      runtime.commitRuntimeGit(params.worktree, params.message)
  }),
  ...GIT_COMMIT_MESSAGE_GENERATION_METHODS,
  defineMethod({
    name: 'git.stage',
    permission: 'workspace',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.stageRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkStage',
    permission: 'workspace',
    params: GitBulkStage,
    handler: async (params, { runtime }) =>
      runtime.bulkStageRuntimeGitPaths(params.worktree, params.filePaths, params.scope)
  }),
  defineMethod({
    name: 'git.resolveConflict',
    permission: 'workspace',
    params: GitResolveConflict,
    handler: async (params, { runtime }) =>
      runtime.resolveRuntimeGitConflict(params.worktree, params.filePath, params.resolution)
  }),
  defineMethod({
    name: 'git.unstage',
    permission: 'workspace',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.unstageRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkUnstage',
    permission: 'workspace',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkUnstageRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.discard',
    permission: 'workspace',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.discardRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkDiscard',
    permission: 'workspace',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkDiscardRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.remoteFileUrl',
    permission: 'workspace',
    params: GitRemoteFileUrl,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitRemoteFileUrl(
        params.worktree,
        params.relativePath,
        params.line,
        params.endLine
      )
  }),
  defineMethod({
    name: 'git.remoteCommitUrl',
    permission: 'workspace',
    params: GitRemoteCommitUrl,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitRemoteCommitUrl(params.worktree, params.sha)
  })
]
