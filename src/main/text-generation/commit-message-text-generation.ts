import type { TextGenerationFailureFields } from '../../shared/text-generation-failure-copy'
import type { BranchNameWorkContext } from '../../shared/source-control/ai/naming/branch-name-from-work'
import type { ConversationNameContext } from '../../shared/source-control/ai/generation/conversation-name-generation'
import type { CommitMessageDraftContext } from '../../shared/source-control/ai/generation/commit-message-generation'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/source-control/ai/generation/commit-message-host-key'

import type {
  GeneratedPullRequestFields,
  PullRequestDraftContext
} from '../../shared/source-control/ai/generation/pull-request-generation'
import type { Repo } from '../../shared/repo-types'
import {
  resolveSourceControlAiForOperation,
  type ResolvedSourceControlAiGenerationParams
} from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { AiTextOperation } from '../../shared/source-control/ai/settings/source-control-ai-settings-types'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import {
  discoverModelsLocal,
  type CommitMessageModelDiscoveryLocalOptions
} from './models/commit-message-model-discovery'
import { discoverModelsWithHostCache } from './models/model-discovery-host-cache'
import { spawnSourceControlAgent } from './execution/source-control-agent-launch'
import { generateConversationName } from './requests/conversation-name-generation-request'
import { cancelLocalGeneration } from './execution/source-control-generation-lanes'
import { commandBackslashMode } from './agent-generation-request'
import {
  generateBranchName,
  generateCommitMessage,
  generatePullRequestFields
} from './requests/source-control-text-generation-requests'
import type {
  CommitMessageGenerationTarget,
  DiscoverCommitMessageModelsResult,
  GenerateBranchNameResult,
  GenerateConversationNameResult,
  GenerateCommitMessageResult,
  GeneratePullRequestFieldsResult as GenericGeneratePullRequestFieldsResult
} from './source-control-text-generation-types'

export type GeneratePullRequestFieldsResult =
  GenericGeneratePullRequestFieldsResult<GeneratedPullRequestFields>

type ResolveCommitMessageSettingsResult =
  | { ok: true; params: ResolvedSourceControlAiGenerationParams }
  | ({ ok: false } & TextGenerationFailureFields)

export function resolveCommitMessageSettings(
  settings: Parameters<typeof resolveSourceControlAiForOperation>[0]['settings'],
  discoveryHostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY,
  operation: AiTextOperation = 'commitMessage',
  repo?: Pick<Repo, 'sourceControlAi'> | null
): ResolveCommitMessageSettingsResult {
  const resolved = resolveSourceControlAiForOperation({
    settings,
    repo,
    operation,
    discoveryHostKey
  })
  return resolved.ok ? { ok: true, params: resolved.value.params } : resolved
}

export function discoverCommitMessageModelsLocal(
  agentId: TuiAgent,
  env: NodeJS.ProcessEnv | undefined,
  agentCommandOverride?: string,
  options: CommitMessageModelDiscoveryLocalOptions = {}
): Promise<DiscoverCommitMessageModelsResult> {
  return discoverModelsWithHostCache({ agentId, agentCommandOverride, env, options }, () =>
    discoverModelsLocal({
      agentId,
      env,
      agentCommandOverride,
      options,
      backslash: commandBackslashMode({
        kind: 'local',
        cwd: options.cwd ?? '',
        wslDistro: options.wslDistro
      }),
      spawnAgent: spawnSourceControlAgent
    })
  )
}

export function cancelGenerateCommitMessageLocal(cwd: string): void {
  cancelLocalGeneration('commit-message', cwd)
}

export function cancelGeneratePullRequestFieldsLocal(cwd: string): void {
  cancelLocalGeneration('pull-request-fields', cwd)
}

export function generateCommitMessageFromContext(
  context: CommitMessageDraftContext,
  params: ResolvedSourceControlAiGenerationParams,
  target: CommitMessageGenerationTarget
): Promise<GenerateCommitMessageResult> {
  return generateCommitMessage({ context, params, target, spawnAgent: spawnSourceControlAgent })
}

export function generatePullRequestFieldsFromContext(
  context: PullRequestDraftContext,
  params: ResolvedSourceControlAiGenerationParams,
  target: CommitMessageGenerationTarget
): Promise<GeneratePullRequestFieldsResult> {
  return generatePullRequestFields({ context, params, target, spawnAgent: spawnSourceControlAgent })
}

export function generateBranchNameFromContext(
  context: BranchNameWorkContext,
  params: ResolvedSourceControlAiGenerationParams,
  target: CommitMessageGenerationTarget
): Promise<GenerateBranchNameResult> {
  return generateBranchName({ context, params, target, spawnAgent: spawnSourceControlAgent })
}

export function generateConversationNameFromContext(
  context: ConversationNameContext,
  params: ResolvedSourceControlAiGenerationParams,
  target: CommitMessageGenerationTarget,
  shouldExecute?: () => boolean
): Promise<GenerateConversationNameResult> {
  return generateConversationName({
    context,
    params,
    target,
    spawnAgent: spawnSourceControlAgent,
    shouldExecute
  })
}
