import {
  generationArgumentText,
  type GenerationArgument
} from '../../shared/source-control/ai/generation/generation-argument'
import { conversationNameTaskPrompt } from '../../shared/source-control/ai/generation/conversation-name-generation'
import { textGenerationFailureCodeFields } from '../../shared/text-generation-failure-copy'
import { runClaudeGenerationAttempts } from '../../shared/claude-background-run-isolation'
import {
  cleanGeneratedCommitMessage,
  stripPrefilledReasoningPreamble
} from '../../shared/source-control/ai/generation/commit-message-agent-output'
import type { CommandTemplateBackslash } from '../../shared/source-control/ai/generation/commit-message-prompt'
import { isCustomAgentId } from '../../shared/source-control/ai/generation/commit-message-agent-spec'
import {
  planCommitMessageGeneration,
  type CommitMessagePlan
} from '../../shared/source-control/ai/generation/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import { openCodeVariantRetryPlan } from '../../shared/opencode-generation-command'
import { copilotUnavailableModelRetryPlan } from './copilot-unavailable-model-retry'
import { runLocalPlanForAgent } from './source-control-local-generation'
import { runOpenCodeTextTask } from '../opencode/text-tasks/opencode-text-task'
import { emptyResultFailure } from './source-control-agent-failure'
import { runRemoteSourceControlPlan } from './source-control-remote-generation'
import type {
  CommitMessageGenerationTarget,
  InternalTextGenerationResult,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from './source-control-text-generation-types'

type GenerateParams = ResolvedSourceControlAiGenerationParams

export function commandBackslashMode(
  target: CommitMessageGenerationTarget,
  platform: NodeJS.Platform = process.platform
): CommandTemplateBackslash {
  return platform === 'win32' && target.kind === 'local' && !target.wslDistro ? 'literal' : 'escape'
}

export async function runGenerationRequest(input: {
  params: GenerateParams
  prompt: string
  target: CommitMessageGenerationTarget
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
}): Promise<InternalTextGenerationResult> {
  const params = {
    ...input.params,
    backslash: commandBackslashMode(input.target)
  }
  const prompt =
    input.operation === 'conversation-name'
      ? conversationNameTaskPrompt(input.prompt)
      : input.prompt
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error, ...textGenerationFailureCodeFields(planned) }
  }
  const localPlan = (result: Extract<typeof planned, { ok: true }>) =>
    input.target.kind === 'local' ? { ...result.plan, args: result.localArgs } : result.plan
  const plainPlan = (plan: CommitMessagePlan<GenerationArgument>): CommitMessagePlan => ({
    ...plan,
    args: plan.args.map(generationArgumentText)
  })
  const plan = localPlan(planned)
  const execute = (
    plan: CommitMessagePlan<GenerationArgument>
  ): Promise<InternalTextGenerationResult> =>
    input.target.kind === 'remote'
      ? runRemoteSourceControlPlan({
          plan: plainPlan(plan),
          target: input.target,
          operation: input.operation
        })
      : plan.openCodeTask
        ? runOpenCodeTextTask({
            plan: plainPlan(plan),
            target: input.target,
            operation: input.operation,
            spawnAgent: input.spawnAgent,
            shouldExecute: input.shouldExecute,
            legacyVariantFlag:
              input.params.agentId === 'opencode' && input.operation !== 'jira-issue-summary'
          })
        : runLocalPlanForAgent({
            agentId: input.params.agentId,
            literalBinary: planned.literalBinary,
            plan,
            target: input.target,
            operation: input.operation,
            spawnAgent: input.spawnAgent,
            shouldExecute: input.shouldExecute
          })
  let result = await runClaudeGenerationAttempts({
    agentId: input.params.agentId,
    run: (attempt): Promise<InternalTextGenerationResult> => {
      if (attempt.strictMcp && !attempt.legacyToolPolicy) {
        return execute(plan)
      }
      const retry = planCommitMessageGeneration(params, prompt, attempt)
      return retry.ok
        ? execute(localPlan(retry))
        : Promise.resolve({
            success: false,
            error: retry.error,
            ...textGenerationFailureCodeFields(retry)
          })
    },
    failedExit: (outcome) => (outcome.success ? undefined : outcome.failureOutput)
  })
  if (
    input.operation !== 'jira-issue-summary' &&
    !result.success &&
    input.params.agentId === 'opencode'
  ) {
    const retry = openCodeVariantRetryPlan(plan, result.failureOutput?.stderr ?? '')
    if (retry) {
      result = await execute(retry)
    }
  }
  if (!result.success && input.params.agentId === 'copilot') {
    const retry = copilotUnavailableModelRetryPlan(plan, result.failureOutput)
    if (retry) {
      result = await execute(retry)
    }
  }
  // Custom raw models can omit the opening think tag; built-in replies may mention it literally. PR JSON strips only after parsing fails.
  if (
    !result.success ||
    !isCustomAgentId(input.params.agentId) ||
    input.operation === 'pull-request-fields' ||
    input.operation === 'jira-issue-summary'
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
    : { success: false, ...emptyResultFailure(input.operation, plan.label) }
}
