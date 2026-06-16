/* eslint-disable max-lines -- Why: this table is the runtime git RPC contract; splitting it would make method coverage harder to audit. */
import { defineMethod, type RpcMethod } from '../core'
import type { GlobalSettings } from '../../../../shared/types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
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
  GitForkSync,
  GitGenerateCommitMessage,
  GitGeneratePullRequestFields,
  GitHistory,
  GitPush,
  GitRebaseFromBase,
  GitRemoteCommitUrl,
  GitRemoteFileUrl,
  GitStatusParams,
  GitTargetedRemote,
  WorktreeSelector
} from './git-params'

type CommitMessageGenerationOverride = {
  commitMessageAi?: GlobalSettings['commitMessageAi']
  sourceControlAi?: GlobalSettings['sourceControlAi']
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
  agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
  enableGitHubAttribution?: boolean
  commitMessageDiscoveryHostKey?: string
}

// Why: generateCommitMessage and generatePullRequestFields share the same optional
// override fields; returning undefined when none are set keeps the no-override call path.
function buildCommitMessageGenerationOverride(params: {
  commitMessageAi?: unknown
  sourceControlAi?: unknown
  sourceControlAiResolvedParams?: unknown
  agentCmdOverrides?: unknown
  enableGitHubAttribution?: boolean
  commitMessageDiscoveryHostKey?: string
}): CommitMessageGenerationOverride | undefined {
  if (
    params.commitMessageAi === undefined &&
    params.sourceControlAi === undefined &&
    params.sourceControlAiResolvedParams === undefined &&
    params.agentCmdOverrides === undefined &&
    params.enableGitHubAttribution === undefined &&
    params.commitMessageDiscoveryHostKey === undefined
  ) {
    return undefined
  }
  return {
    ...(params.commitMessageAi !== undefined
      ? { commitMessageAi: params.commitMessageAi as GlobalSettings['commitMessageAi'] }
      : {}),
    ...(params.sourceControlAi !== undefined
      ? { sourceControlAi: params.sourceControlAi as GlobalSettings['sourceControlAi'] }
      : {}),
    ...(params.sourceControlAiResolvedParams !== undefined
      ? {
          sourceControlAiResolvedParams:
            params.sourceControlAiResolvedParams as ResolvedSourceControlAiGenerationParams
        }
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
  }
}

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
      const override = buildCommitMessageGenerationOverride(params)
      if (override === undefined) {
        return runtime.generateRuntimeCommitMessage(params.worktree)
      }
      return runtime.generateRuntimeCommitMessage(params.worktree, override)
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
      const override = buildCommitMessageGenerationOverride(params)
      if (override === undefined) {
        return runtime.generateRuntimePullRequestFields(params.worktree, input)
      }
      return runtime.generateRuntimePullRequestFields(params.worktree, input, override)
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
  }),
  defineMethod({
    name: 'git.remoteCommitUrl',
    params: GitRemoteCommitUrl,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitRemoteCommitUrl(params.worktree, params.sha)
  })
]
