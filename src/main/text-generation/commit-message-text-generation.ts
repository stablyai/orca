import type { BranchNameWorkContext } from '../../shared/branch-name-from-work'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  GeneratedPullRequestFields,
  PullRequestDraftContext
} from '../../shared/pull-request-generation'
import type { Repo } from '../../shared/repo-types'
import {
  resolveSourceControlAiForOperation,
  type ResolvedSourceControlAiGenerationParams
} from '../../shared/source-control-ai'
import type { SourceControlAiOperation } from '../../shared/source-control-ai-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  discoverModelsLocal,
  discoverModelsRemote,
  type CommitMessageModelDiscoveryLocalOptions
} from './commit-message-model-discovery'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import {
  commandBackslashMode as resolveCommandBackslashMode,
  generateBranchName,
  generateCommitMessage,
  generatePullRequestFields,
  generateText,
  trimGeneratedCommitMessage as trimCommitMessage
} from './source-control-text-generation-requests'
import type {
  CommitMessageGenerationTarget,
  DiscoverCommitMessageModelsResult,
  GenerateBranchNameResult,
  GenerateCommitMessageResult,
  GeneratePullRequestFieldsResult as GenericGeneratePullRequestFieldsResult,
  GenerateTextResult,
  RemoteCommitMessageExecResult,
  TextGenerationOperation
} from './source-control-text-generation-types'

export type GenerateCommitMessageParams = ResolvedSourceControlAiGenerationParams
export type {
  CommitMessageGenerationTarget,
  CommitMessageModelDiscoveryLocalOptions,
  DiscoverCommitMessageModelsResult,
  GenerateBranchNameResult,
  GenerateCommitMessageResult,
  GenerateTextResult,
  RemoteCommitMessageExecResult,
  TextGenerationOperation
}
export type GeneratePullRequestFieldsResult =
  GenericGeneratePullRequestFieldsResult<GeneratedPullRequestFields>

type ResolveCommitMessageSettingsResult =
  | { ok: true; params: GenerateCommitMessageParams }
  | { ok: false; error: string }

export function trimGeneratedCommitMessage(message: string): string {
  return trimCommitMessage(message)
}

export function resolveCommitMessageSettings(
  settings: GlobalSettings,
  discoveryHostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY,
  operation: SourceControlAiOperation = 'commitMessage',
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

export function resolveTextGenerationParams(
  settings: GlobalSettings,
  discoveryHostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY,
  operation: SourceControlAiOperation = 'commitMessage',
  repo?: Pick<Repo, 'sourceControlAi'> | null
): ResolveCommitMessageSettingsResult {
  return resolveCommitMessageSettings(settings, discoveryHostKey, operation, repo)
}

export function commandBackslashMode(
  target: CommitMessageGenerationTarget,
  platform: NodeJS.Platform = process.platform
): CommandTemplateBackslash {
  return resolveCommandBackslashMode(target, platform)
}

export async function discoverCommitMessageModelsLocal(
  agentId: TuiAgent,
  env: NodeJS.ProcessEnv | undefined,
  agentCommandOverride?: string,
  options: CommitMessageModelDiscoveryLocalOptions = {}
): Promise<DiscoverCommitMessageModelsResult> {
  return discoverModelsLocal({
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
}

export async function discoverCommitMessageModelsRemote(
  agentId: TuiAgent,
  cwd: string,
  execute: (
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number
  ) => Promise<RemoteCommitMessageExecResult>,
  agentCommandOverride?: string
): Promise<DiscoverCommitMessageModelsResult> {
  return discoverModelsRemote({ agentId, cwd, execute, agentCommandOverride })
}

export function cancelGenerateCommitMessageLocal(cwd: string): void {
  cancelLocalGeneration('commit-message', cwd)
}

export function cancelGeneratePullRequestFieldsLocal(cwd: string): void {
  cancelLocalGeneration('pull-request-fields', cwd)
}

export function generateTextFromPrompt(
  prompt: string,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget,
  operation: TextGenerationOperation = 'mission-plan'
): Promise<GenerateTextResult> {
  return generateText({
    prompt,
    params,
    target,
    operation,
    spawnAgent: spawnSourceControlAgent
  })
}

export function generateCommitMessageFromContext(
  context: CommitMessageDraftContext,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget
): Promise<GenerateCommitMessageResult> {
  return generateCommitMessage({ context, params, target, spawnAgent: spawnSourceControlAgent })
}

export function generatePullRequestFieldsFromContext(
  context: PullRequestDraftContext,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget
): Promise<GeneratePullRequestFieldsResult> {
  return generatePullRequestFields({ context, params, target, spawnAgent: spawnSourceControlAgent })
}

export function generateBranchNameFromContext(
  context: BranchNameWorkContext,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget
): Promise<GenerateBranchNameResult> {
  return generateBranchName({ context, params, target, spawnAgent: spawnSourceControlAgent })
}
