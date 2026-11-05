import { defineMethod } from '../core'
import { generationOwner } from '../authenticated-generation-owner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
import {
  GitDiscoverCommitMessageModels,
  GitGenerateCommitMessage,
  GitGeneratePullRequestFields,
  GitCancelGeneration
} from '../../../../shared/rpc-contract/git-params'

type CommitMessageGenerationOverride = {
  commitMessageAi?: GlobalSettings['commitMessageAi']
  sourceControlAi?: GlobalSettings['sourceControlAi']
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
  agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
  defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
  commitMessageDiscoveryHostKey?: string
}

// Share optional overrides across commit/PR generation; undefined preserves the no-override path.
function buildCommitMessageGenerationOverride(params: {
  commitMessageAi?: unknown
  sourceControlAi?: unknown
  sourceControlAiResolvedParams?: unknown
  agentCmdOverrides?: unknown
  defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
  commitMessageDiscoveryHostKey?: string
}): CommitMessageGenerationOverride | undefined {
  if (
    params.commitMessageAi === undefined &&
    params.sourceControlAi === undefined &&
    params.sourceControlAiResolvedParams === undefined &&
    params.agentCmdOverrides === undefined &&
    params.defaultTuiAgent === undefined &&
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
    ...(params.defaultTuiAgent !== undefined ? { defaultTuiAgent: params.defaultTuiAgent } : {}),
    ...(params.commitMessageDiscoveryHostKey !== undefined
      ? { commitMessageDiscoveryHostKey: params.commitMessageDiscoveryHostKey }
      : {})
  }
}

export const GIT_COMMIT_MESSAGE_GENERATION_METHODS = [
  defineMethod({
    name: 'git.generateCommitMessage',
    requires: ['accounts'],
    permission: 'workspace',
    params: GitGenerateCommitMessage,
    handler: async (params, context) => {
      const { runtime } = context
      const override = buildCommitMessageGenerationOverride(params)
      if (params.generationId !== undefined) {
        return runtime.generateRuntimeCommitMessage(params.worktree, override, {
          owner: generationOwner(context, 'source control', true),
          generationId: params.generationId
        })
      }
      if (override === undefined) {
        return runtime.generateRuntimeCommitMessage(params.worktree)
      }
      return runtime.generateRuntimeCommitMessage(params.worktree, override)
    }
  }),
  defineMethod({
    name: 'git.discoverCommitMessageModels',
    permission: 'workspace',
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
    permission: 'workspace',
    params: GitCancelGeneration,
    handler: async (params, context) =>
      params.generationId === undefined
        ? context.runtime.cancelRuntimeGenerateCommitMessage(params.worktree)
        : context.runtime.cancelRuntimeGenerateCommitMessage(params.worktree, {
            owner: generationOwner(context, 'source control', true),
            generationId: params.generationId
          })
  }),
  defineMethod({
    name: 'git.generatePullRequestFields',
    permission: 'workspace',
    params: GitGeneratePullRequestFields,
    handler: async (params, context) => {
      const { runtime } = context
      const input = {
        base: params.base,
        title: params.title,
        body: params.body,
        draft: params.draft,
        provider: params.provider,
        useTemplate: params.useTemplate
      }
      const override = buildCommitMessageGenerationOverride(params)
      if (params.generationId !== undefined) {
        return runtime.generateRuntimePullRequestFields(params.worktree, input, override, {
          owner: generationOwner(context, 'source control', true),
          generationId: params.generationId
        })
      }
      if (override === undefined) {
        return runtime.generateRuntimePullRequestFields(params.worktree, input)
      }
      return runtime.generateRuntimePullRequestFields(params.worktree, input, override)
    }
  }),
  defineMethod({
    name: 'git.cancelGeneratePullRequestFields',
    permission: 'workspace',
    params: GitCancelGeneration,
    handler: async (params, context) =>
      params.generationId === undefined
        ? context.runtime.cancelRuntimeGeneratePullRequestFields(params.worktree)
        : context.runtime.cancelRuntimeGeneratePullRequestFields(params.worktree, {
            owner: generationOwner(context, 'source control', true),
            generationId: params.generationId
          })
  })
]
