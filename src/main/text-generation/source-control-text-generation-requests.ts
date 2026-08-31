import {
  buildCommitMessagePrompt,
  splitGeneratedCommitMessage,
  type CommitMessageDraftContext
} from '../../shared/commit-message-generation'
import {
  buildPullRequestFieldsPrompt,
  parseGeneratedPullRequestFields,
  type GeneratedPullRequestFields,
  type PullRequestDraftContext
} from '../../shared/pull-request-generation'
import {
  buildBranchNamePrompt,
  sanitizeBranchSlug,
  type BranchNameWorkContext
} from '../../shared/branch-name-from-work'
import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import {
  planCommitMessageGeneration,
  type CommitMessagePlan,
  type CommitMessagePlanResult
} from '../../shared/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { formatLinkedIssueTemplateValue } from '../../shared/source-control-ai-action-variables'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control-ai-actions'
import { captureAgentGenerationFailureOutput } from './agent-failure-output'
import { planOmpMissionGeneration } from './omp-mission-generation-plan'
import { withOmpMissionProcessFiles } from './omp-mission-process-files'
import { runLocalPlanForAgent } from './source-control-local-generation'
import { runRemoteSourceControlPlan } from './source-control-remote-generation'
import type {
  CommitMessageGenerationTarget,
  GenerateBranchNameResult,
  GenerateCommitMessageResult,
  GeneratePullRequestFieldsResult,
  GenerateTextResult,
  InternalTextGenerationResult,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from './source-control-text-generation-types'

type GenerateParams = ResolvedSourceControlAiGenerationParams

export function trimGeneratedCommitMessage(message: string): string {
  return message.replace(/\s+$/, '')
}

export function commandBackslashMode(
  target: CommitMessageGenerationTarget,
  platform: NodeJS.Platform = process.platform
): CommandTemplateBackslash {
  return platform === 'win32' && target.kind === 'local' && !target.wslDistro ? 'literal' : 'escape'
}

async function executeGenerationPlan(input: {
  params: GenerateParams
  plan: CommitMessagePlan
  target: CommitMessageGenerationTarget
  emptyResultName: string
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
}): Promise<InternalTextGenerationResult> {
  return input.target.kind === 'remote'
    ? runRemoteSourceControlPlan({
        plan: input.plan,
        target: input.target,
        emptyResultName: input.emptyResultName,
        operation: input.operation
      })
    : runLocalPlanForAgent({
        agentId: input.params.agentId,
        plan: input.plan,
        target: input.target,
        emptyResultName: input.emptyResultName,
        operation: input.operation,
        spawnAgent: input.spawnAgent
      })
}

type GenerateTextInput = {
  prompt: string
  params: GenerateParams
  target: CommitMessageGenerationTarget
  operation: TextGenerationOperation
  useAgentDefaultModel?: boolean
  spawnAgent: SpawnSourceControlAgent
}

export async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
  const backslash = commandBackslashMode(input.target)
  // OMP planning must not change the Source Control AI capability registry.
  if (
    input.operation === 'mission-plan' &&
    input.params.agentId === 'omp' &&
    input.useAgentDefaultModel
  ) {
    if (input.target.kind !== 'local' || input.target.wslDistro) {
      return {
        success: false,
        error: 'OMP Mission planning requires the local controller host for its isolated process.'
      }
    }
    try {
      return await withOmpMissionProcessFiles((files) =>
        generatePlannedText(
          input,
          planOmpMissionGeneration(
            input.prompt,
            input.params.agentCommandOverride,
            backslash,
            files
          )
        )
      )
    } catch {
      return {
        success: false,
        error: 'OMP Mission planner could not prepare its isolated process.'
      }
    }
  }
  return generatePlannedText(
    input,
    planCommitMessageGeneration(
      { ...input.params, backslash, useAgentDefaultModel: input.useAgentDefaultModel },
      input.prompt
    )
  )
}

async function generatePlannedText(
  input: GenerateTextInput,
  planned: CommitMessagePlanResult
): Promise<GenerateTextResult> {
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const result = await executeGenerationPlan({
    ...input,
    plan: planned.plan,
    emptyResultName: 'text'
  })
  return result.success
    ? { success: true, text: result.rawOutput, agentLabel: result.agentLabel }
    : { success: false, error: result.error, canceled: result.canceled }
}

export async function generateCommitMessage(input: {
  context: CommitMessageDraftContext
  params: GenerateParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
}): Promise<GenerateCommitMessageResult> {
  const { context, params, target } = input
  const basePrompt = buildCommitMessagePrompt(context, '')
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? '(detached)',
          stagedFiles: context.stagedSummary,
          stagedPatch: context.stagedPatch,
          linkedIssue: formatLinkedIssueTemplateValue(context.linkedIssue)
        })
      : buildCommitMessagePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(
    { ...params, backslash: commandBackslashMode(target) },
    prompt
  )
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const result = await executeGenerationPlan({
    ...input,
    plan: planned.plan,
    emptyResultName: 'message',
    operation: 'commit-message'
  })
  if (!result.success) {
    return { success: false, error: result.error, canceled: result.canceled }
  }
  try {
    return {
      success: true,
      message: trimGeneratedCommitMessage(splitGeneratedCommitMessage(result.rawOutput).message),
      agentLabel: result.agentLabel
    }
  } catch {
    return { success: false, error: 'Generated commit message could not be parsed.' }
  }
}

export async function generatePullRequestFields(input: {
  context: PullRequestDraftContext
  params: GenerateParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
}): Promise<GeneratePullRequestFieldsResult<GeneratedPullRequestFields>> {
  const { context, params, target } = input
  const basePrompt = buildPullRequestFieldsPrompt(context, '')
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? '(detached)',
          baseBranch: context.base,
          currentTitle: context.currentTitle,
          currentBody: context.currentBody,
          commitSummary: context.commitSummary,
          changedFiles: context.changeSummary,
          patch: context.patch,
          linkedIssue: formatLinkedIssueTemplateValue(context.linkedIssue)
        })
      : buildPullRequestFieldsPrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(
    { ...params, backslash: commandBackslashMode(target) },
    prompt
  )
  if (!planned.ok) {
    return {
      success: false,
      error: planned.error,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
  const result = await executeGenerationPlan({
    ...input,
    plan: planned.plan,
    emptyResultName: 'details',
    operation: 'pull-request-fields'
  })
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      canceled: result.canceled,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
  try {
    return {
      success: true,
      fields: parseGeneratedPullRequestFields(result.rawOutput, context),
      agentLabel: result.agentLabel,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  } catch {
    return {
      success: false,
      error: 'Generated pull request details could not be parsed.',
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
}

export async function generateBranchName(input: {
  context: BranchNameWorkContext
  params: GenerateParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
}): Promise<GenerateBranchNameResult> {
  const { context, params, target } = input
  const basePrompt = buildBranchNamePrompt(context)
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          firstPrompt: context.firstPrompt,
          assistantMessage: context.assistantMessage ?? ''
        })
      : buildBranchNamePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(
    { ...params, backslash: commandBackslashMode(target) },
    prompt
  )
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const result = await executeGenerationPlan({
    ...input,
    plan: planned.plan,
    emptyResultName: 'branch name',
    operation: 'branch-name'
  })
  if (!result.success) {
    return result
  }
  const slug = sanitizeBranchSlug(result.rawOutput)
  return slug
    ? { success: true, slug, agentLabel: result.agentLabel }
    : {
        success: false,
        error: 'Generated branch name was empty after sanitization.',
        failureOutput:
          captureAgentGenerationFailureOutput(planned.plan.label, 0, result.rawOutput, '') ??
          undefined
      }
}
