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
  stripPrefilledReasoningPreamble
} from '../../shared/commit-message-prompt'
import { isCustomAgentId } from '../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { formatLinkedIssueTemplateValue } from '../../shared/source-control-ai-action-variables'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control-ai-actions'
import { captureAgentGenerationFailureOutput } from './agent-failure-output'
import { runGenerationRequest } from './agent-generation-request'
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

export async function generateCommitMessage(input: {
  context: CommitMessageDraftContext
  params: GenerateParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
}): Promise<GenerateCommitMessageResult> {
  const { context, params } = input
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
  const result = await runGenerationRequest({
    ...input,
    prompt,
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
  const { context, params } = input
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
  const result = await runGenerationRequest({
    ...input,
    prompt,
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
          captureAgentGenerationFailureOutput(
            result.agentLabel ?? params.agentId,
            0,
            result.rawOutput,
            ''
          ) ?? undefined
      }
}
