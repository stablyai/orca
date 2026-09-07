import { defineMethod, type RpcMethod } from '../core'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
import {
  GitDiscoverCommitMessageModels,
  GitGenerateCommitMessage,
  GitGeneratePullRequestFields,
  WorktreeSelector
} from './git-params'

type CommitMessageGenerationOverride = {
  commitMessageAi?: GlobalSettings['commitMessageAi']
  sourceControlAi?: GlobalSettings['sourceControlAi']
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
  agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
  commitMessageDiscoveryHostKey?: string
}

// Why: generateCommitMessage and generatePullRequestFields share the same optional
// override fields; returning undefined when none are set keeps the no-override call path.
function buildCommitMessageGenerationOverride(params: {
  commitMessageAi?: unknown
  sourceControlAi?: unknown
  sourceControlAiResolvedParams?: unknown
  agentCmdOverrides?: unknown
  commitMessageDiscoveryHostKey?: string
}): CommitMessageGenerationOverride | undefined {
  if (
    params.commitMessageAi === undefined &&
    params.sourceControlAi === undefined &&
    params.sourceControlAiResolvedParams === undefined &&
    params.agentCmdOverrides === undefined &&
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
    ...(params.commitMessageDiscoveryHostKey !== undefined
      ? { commitMessageDiscoveryHostKey: params.commitMessageDiscoveryHostKey }
      : {})
  }
}

export const GIT_COMMIT_MESSAGE_GENERATION_METHODS: RpcMethod[] = [
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
        draft: params.draft,
        provider: params.provider,
        useTemplate: params.useTemplate
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
  })
]
