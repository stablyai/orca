import { runClaudeBackgroundAttempts } from '../../shared/claude-background-run-isolation'
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
import { openCodeVariantRetryPlan } from '../../shared/opencode-generation-command'
import { runLocalPlanForAgent } from './source-control-local-generation'
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
  emptyResultName: string
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
}): Promise<InternalTextGenerationResult> {
  const params = { ...input.params, backslash: commandBackslashMode(input.target) }
  const planned = planCommitMessageGeneration(params, input.prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const plan = planned.plan
  const execute = (plan: CommitMessagePlan): Promise<InternalTextGenerationResult> =>
    input.target.kind === 'remote'
      ? runRemoteSourceControlPlan({
          plan,
          target: input.target,
          emptyResultName: input.emptyResultName,
          operation: input.operation
        })
      : runLocalPlanForAgent({
          agentId: input.params.agentId,
          plan,
          target: input.target,
          emptyResultName: input.emptyResultName,
          operation: input.operation,
          spawnAgent: input.spawnAgent
        })
  let result = await runClaudeBackgroundAttempts({
    agentId: input.params.agentId,
    run: (strictMcp): Promise<InternalTextGenerationResult> => {
      if (strictMcp) {
        return execute(plan)
      }
      const retry = planCommitMessageGeneration(params, input.prompt, { strictMcp })
      return retry.ok
        ? execute(retry.plan)
        : Promise.resolve({ success: false, error: retry.error })
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
    : { success: false, error: `${plan.label} returned an empty ${input.emptyResultName}.` }
}
