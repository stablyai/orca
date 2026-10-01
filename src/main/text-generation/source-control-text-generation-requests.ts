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
import {
  cleanGeneratedCommitMessage,
  stripPrefilledReasoningPreamble,
  type CommandTemplateBackslash
} from '../../shared/commit-message-prompt'
import { isCustomAgentId } from '../../shared/commit-message-agent-spec'
import {
  planCommitMessageGeneration,
  type CommitMessagePlan
} from '../../shared/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { formatLinkedIssueTemplateValue } from '../../shared/source-control-ai-action-variables'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control-ai-actions'
import { captureAgentGenerationFailureOutput } from './agent-failure-output'
import { runLocalPlanForAgent } from './source-control-local-generation'
import { runRemoteSourceControlPlan } from './source-control-remote-generation'
import type {
  CommitMessageGenerationTarget,
  GenerateBranchNameResult,
  GenerateCommitMessageResult,
  GeneratePullRequestFieldsResult,
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
  const result = await (input.target.kind === 'remote'
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
      }))
  // Why: only a custom command runs a raw model whose chat template can swallow
  // the opening think tag; a built-in agent's message may just mention the tag.
  // PR fields are JSON, so they strip only when parsing fails instead.
  if (
    !result.success ||
    !isCustomAgentId(input.params.agentId) ||
    input.operation === 'pull-request-fields'
  ) {
    return result
  }
  const answer = stripPrefilledReasoningPreamble(result.rawOutput)
  if (answer === result.rawOutput) {
    return result
  }
  const rawOutput = cleanGeneratedCommitMessage(answer)
  return rawOutput
    ? { ...result, rawOutput }
    : { success: false, error: `${input.plan.label} returned an empty ${input.emptyResultName}.` }
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
      fields: parsePullRequestFieldsOutput(result.rawOutput, context, params.agentId),
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

// Why: a body may quote a lone closing tag inside valid JSON, so reasoning is
// stripped only when the untouched output does not parse.
function parsePullRequestFieldsOutput(
  raw: string,
  context: PullRequestDraftContext,
  agentId: GenerateParams['agentId']
): GeneratedPullRequestFields {
  try {
    return parseGeneratedPullRequestFields(raw, context)
  } catch (error) {
    const answer = isCustomAgentId(agentId) ? stripPrefilledReasoningPreamble(raw) : raw
    if (answer === raw) {
      throw error
    }
    return parseGeneratedPullRequestFields(cleanGeneratedCommitMessage(answer), context)
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
