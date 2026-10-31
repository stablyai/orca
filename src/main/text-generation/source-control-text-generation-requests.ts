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
  STAGED_DIFF_BYTE_BUDGET,
  stripPrefilledReasoningPreamble
} from '../../shared/commit-message-prompt'
import { isCustomAgentId } from '../../shared/commit-message-agent-spec'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { formatLinkedIssueTemplateValue } from '../../shared/source-control-ai-action-variables'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control-ai-actions'
import {
  textGenerationFailure,
  textGenerationFailureCodeFields
} from '../../shared/text-generation-failure-copy'
import { captureAgentGenerationFailureOutput } from './agent-failure-output'
import { commandBackslashMode, runGenerationRequest } from './agent-generation-request'
import { fitsLocalCommandLine } from './source-control-local-process'
export { commandBackslashMode } from './agent-generation-request'
import type {
  CommitMessageGenerationTarget,
  GenerateBranchNameResult,
  GenerateCommitMessageResult,
  GeneratePullRequestFieldsResult,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

type GenerateParams = ResolvedSourceControlAiGenerationParams

export function trimGeneratedCommitMessage(message: string): string {
  return message.replace(/\s+$/, '')
}

// Leaves room for retry plans' extra flags.
const COMMAND_LINE_FIT_HEADROOM = 1_000

/** Argv-delivered prompts must fit the local command line, so shrink only the patch to the largest budget that fits. */
function fitPromptToLocalCommandLine(
  params: GenerateParams,
  target: CommitMessageGenerationTarget,
  build: (diffBudget?: number) => string
): string {
  const prompt = build()
  // The WSL launcher re-wraps argv in a login-shell script, so this plan's size does not bound it; keep the guard's verdict.
  if (
    target.kind !== 'local' ||
    target.wslDistro ||
    (process.platform !== 'win32' && process.platform !== 'linux')
  ) {
    return prompt
  }
  const fits = (candidate: string): boolean => {
    const planned = planCommitMessageGeneration(
      { ...params, backslash: commandBackslashMode(target) },
      candidate
    )
    return !planned.ok || fitsLocalCommandLine(planned.plan, COMMAND_LINE_FIT_HEADROOM)
  }
  if (fits(prompt)) {
    return prompt
  }
  const minimum = build(0)
  if (!fits(minimum)) {
    return prompt
  }
  let best = minimum
  let low = 1
  let high = STAGED_DIFF_BYTE_BUDGET
  while (low <= high) {
    const budget = Math.floor((low + high) / 2)
    const candidate = build(budget)
    if (fits(candidate)) {
      best = candidate
      low = budget + 1
    } else {
      high = budget - 1
    }
  }
  return best
}

export async function generateCommitMessage(input: {
  context: CommitMessageDraftContext
  params: GenerateParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
}): Promise<GenerateCommitMessageResult> {
  const { context, params } = input
  const prompt = fitPromptToLocalCommandLine(params, input.target, (diffBudget) =>
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt: buildCommitMessagePrompt(context, '', diffBudget),
          branch: context.branch ?? '(detached)',
          stagedFiles: context.stagedSummary,
          stagedPatch: context.stagedPatch,
          linkedIssue: formatLinkedIssueTemplateValue(context.linkedIssue)
        })
      : buildCommitMessagePrompt(context, params.customPrompt ?? '', diffBudget)
  )
  const result = await runGenerationRequest({
    ...input,
    prompt,
    operation: 'commit-message'
  })
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      canceled: result.canceled,
      ...textGenerationFailureCodeFields(result)
    }
  }
  try {
    return {
      success: true,
      message: trimGeneratedCommitMessage(splitGeneratedCommitMessage(result.rawOutput).message),
      agentLabel: result.agentLabel
    }
  } catch {
    return {
      success: false,
      ...textGenerationFailure('commitMessageUnparseable')
    }
  }
}

export async function generatePullRequestFields(input: {
  context: PullRequestDraftContext
  params: GenerateParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
}): Promise<GeneratePullRequestFieldsResult<GeneratedPullRequestFields>> {
  const { context, params } = input
  const prompt = fitPromptToLocalCommandLine(params, input.target, (diffBudget) =>
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt: buildPullRequestFieldsPrompt(context, '', diffBudget),
          branch: context.branch ?? '(detached)',
          baseBranch: context.base,
          currentTitle: context.currentTitle,
          currentBody: context.currentBody,
          commitSummary: context.commitSummary,
          changedFiles: context.changeSummary,
          patch: context.patch,
          linkedIssue: formatLinkedIssueTemplateValue(context.linkedIssue)
        })
      : buildPullRequestFieldsPrompt(context, params.customPrompt ?? '', diffBudget)
  )
  const result = await runGenerationRequest({
    ...input,
    prompt,
    operation: 'pull-request-fields'
  })
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      canceled: result.canceled,
      branchChangedByPreparation: context.branchChangedByPreparation,
      ...textGenerationFailureCodeFields(result)
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
      ...textGenerationFailure('pullRequestDetailsUnparseable'),
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
}

// Valid JSON may quote a lone closing think tag; strip reasoning only after the original fails parsing.
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
  const { context, params } = input
  const basePrompt = buildBranchNamePrompt(context)
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          firstPrompt: context.firstPrompt,
          assistantMessage: context.assistantMessage ?? ''
        })
      : buildBranchNamePrompt(context, params.customPrompt ?? '')
  const result = await runGenerationRequest({
    ...input,
    prompt,
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
          captureAgentGenerationFailureOutput(
            result.agentLabel ?? params.agentId,
            0,
            result.rawOutput,
            ''
          ) ?? undefined
      }
}
