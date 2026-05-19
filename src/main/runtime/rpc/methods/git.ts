import { defineMethod, type RpcMethod } from '../core'
import type { GlobalSettings } from '../../../../shared/types'
import {
  GitBranchCompare,
  GitBranchDiff,
  GitBulkPaths,
  GitCheckIgnored,
  GitCommit,
  GitCommitCompare,
  GitCommitDiff,
  GitDiscoverCommitMessageModels,
  GitDiff,
  GitFilePath,
  GitGenerateCommitMessage,
  GitGeneratePullRequestFields,
  GitHistory,
  GitPush,
  GitRemoteFileUrl,
  GitStatusParams,
  WorktreeSelector
} from './git-params'

export const GIT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'git.status',
    params: GitStatusParams,
    handler: async (params, { runtime }) =>
      params.includeIgnored === undefined
        ? runtime.getRuntimeGitStatus(params.worktree)
        : runtime.getRuntimeGitStatus(params.worktree, { includeIgnored: params.includeIgnored })
  }),
  defineMethod({
    name: 'git.checkIgnored',
    params: GitCheckIgnored,
    handler: async (params, { runtime }) =>
      runtime.checkRuntimeGitIgnoredPaths(params.worktree, params.paths)
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
    name: 'git.diff',
    params: GitDiff,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitDiff(
        params.worktree,
        params.filePath,
        params.staged,
        params.compareAgainstHead
      )
  }),
  defineMethod({
    name: 'git.branchCompare',
    params: GitBranchCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitBranchCompare(params.worktree, params.baseRef)
  }),
  defineMethod({
    name: 'git.commitCompare',
    params: GitCommitCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitCommitCompare(params.worktree, params.commitId)
  }),
  defineMethod({
    name: 'git.upstreamStatus',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.getRuntimeGitUpstreamStatus(params.worktree)
  }),
  defineMethod({
    name: 'git.fetch',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.fetchRuntimeGit(params.worktree)
  }),
  defineMethod({
    name: 'git.pull',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.pullRuntimeGit(params.worktree)
  }),
  defineMethod({
    name: 'git.push',
    params: GitPush,
    handler: async (params, { runtime }) =>
      runtime.pushRuntimeGit(params.worktree, params.publish, params.pushTarget as never)
  }),
  defineMethod({
    name: 'git.branchDiff',
    params: GitBranchDiff,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitBranchDiff(
        params.worktree,
        params.compare,
        params.filePath,
        params.oldPath
      )
  }),
  defineMethod({
    name: 'git.commitDiff',
    params: GitCommitDiff,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitCommitDiff(params.worktree, {
        commitOid: params.commitOid,
        parentOid: params.parentOid,
        filePath: params.filePath,
        oldPath: params.oldPath
      })
  }),
  defineMethod({
    name: 'git.commit',
    params: GitCommit,
    handler: async (params, { runtime }) =>
      runtime.commitRuntimeGit(params.worktree, params.message)
  }),
  defineMethod({
    name: 'git.generateCommitMessage',
    params: GitGenerateCommitMessage,
    handler: async (params, { runtime }) => {
      if (
        params.commitMessageAi === undefined &&
        params.agentCmdOverrides === undefined &&
        params.enableGitHubAttribution === undefined &&
        params.commitMessageDiscoveryHostKey === undefined
      ) {
        return runtime.generateRuntimeCommitMessage(params.worktree)
      }
      return runtime.generateRuntimeCommitMessage(params.worktree, {
        ...(params.commitMessageAi !== undefined
          ? { commitMessageAi: params.commitMessageAi as GlobalSettings['commitMessageAi'] }
          : {}),
        ...(params.agentCmdOverrides !== undefined
          ? {
              agentCmdOverrides: params.agentCmdOverrides as GlobalSettings['agentCmdOverrides']
            }
          : {}),
        ...(params.enableGitHubAttribution !== undefined
          ? { enableGitHubAttribution: params.enableGitHubAttribution }
          : {}),
        ...(params.commitMessageDiscoveryHostKey !== undefined
          ? { commitMessageDiscoveryHostKey: params.commitMessageDiscoveryHostKey }
          : {})
      })
    }
  }),
  defineMethod({
    name: 'git.discoverCommitMessageModels',
    params: GitDiscoverCommitMessageModels,
    handler: async (params, { runtime }) =>
      runtime.discoverRuntimeCommitMessageModels(
        params.worktree,
        params.agentId,
        params.agentCmdOverrides !== undefined
          ? {
              agentCmdOverrides: params.agentCmdOverrides as GlobalSettings['agentCmdOverrides']
            }
          : {}
      )
  }),
  defineMethod({
    name: 'git.cancelGenerateCommitMessage',
    params: WorktreeSelector,
    handler: async (params, { runtime }) =>
      runtime.cancelRuntimeGenerateCommitMessage(params.worktree)
  }),
  defineMethod({
    name: 'git.generatePullRequestFields',
    params: GitGeneratePullRequestFields,
    handler: async (params, { runtime }) => {
      const input = {
        base: params.base,
        title: params.title,
        body: params.body,
        draft: params.draft
      }
      if (
        params.commitMessageAi === undefined &&
        params.agentCmdOverrides === undefined &&
        params.enableGitHubAttribution === undefined &&
        params.commitMessageDiscoveryHostKey === undefined
      ) {
        return runtime.generateRuntimePullRequestFields(params.worktree, input)
      }
      return runtime.generateRuntimePullRequestFields(params.worktree, input, {
        ...(params.commitMessageAi !== undefined
          ? { commitMessageAi: params.commitMessageAi as GlobalSettings['commitMessageAi'] }
          : {}),
        ...(params.agentCmdOverrides !== undefined
          ? {
              agentCmdOverrides: params.agentCmdOverrides as GlobalSettings['agentCmdOverrides']
            }
          : {}),
        ...(params.enableGitHubAttribution !== undefined
          ? { enableGitHubAttribution: params.enableGitHubAttribution }
          : {}),
        ...(params.commitMessageDiscoveryHostKey !== undefined
          ? { commitMessageDiscoveryHostKey: params.commitMessageDiscoveryHostKey }
          : {})
      })
    }
  }),
  defineMethod({
    name: 'git.cancelGeneratePullRequestFields',
    params: WorktreeSelector,
    handler: async (params, { runtime }) =>
      runtime.cancelRuntimeGeneratePullRequestFields(params.worktree)
  }),
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
  })
]
