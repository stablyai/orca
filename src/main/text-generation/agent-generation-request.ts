import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import { runTextSubscriptionRequest } from './text-subscription-request'
import {
  textGenerationFailure,
  textGenerationFailureCodeFields
} from '../../shared/text-generation-failure-copy'
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
import { localGenerationCanceledResult } from './source-control-generation-lanes'
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
  if (
    input.target.kind === 'local' &&
    !input.target.request &&
    input.target.generationRequest?.budget
  ) {
    input = {
      ...input,
      target: { ...input.target, request: input.target.generationRequest.budget }
    }
  }
  if (input.target.kind === 'local' && input.target.generationRequest?.canceled) {
    return localGenerationCanceledResult()
  }
  if (input.target.kind === 'local' && input.target.subscription) {
    if (JSON.stringify(input.params) !== JSON.stringify(input.target.subscription.params)) {
      return {
        success: false,
        canceled: true,
        ...textGenerationFailure('generationRequestChanged')
      }
    }
    return runTextSubscriptionRequest({
      target: input.target,
      execute: (target, model) =>
        runGenerationRequest({
          ...input,
          target,
          params: { ...input.params, ...(model ? { model } : {}) }
        })
    })
  }
  const params = {
    ...input.params,
    backslash: commandBackslashMode(input.target)
  }
  const planned = planCommitMessageGeneration(params, input.prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error, ...textGenerationFailureCodeFields(planned) }
  }
  const configure =
    input.target.kind === 'local' ? input.target.accountAttempt?.configurePlan : undefined
  const plan = configure ? configure(planned.plan) : planned.plan
  const execute = async (plan: CommitMessagePlan): Promise<InternalTextGenerationResult> => {
    if (input.target.kind === 'local' && input.target.generationRequest?.canceled) {
      return localGenerationCanceledResult()
    }
    if (
      input.target.kind === 'local' &&
      input.target.request &&
      !(await input.target.request.validate())
    ) {
      return localGenerationCanceledResult()
    }
    if (
      input.target.kind === 'local' &&
      input.target.accountAttempt &&
      !(await Promise.resolve(input.target.accountAttempt.valid()).catch(() => false))
    ) {
      return {
        success: false,
        subscriptionAccountChanged: true,
        ...textGenerationFailure('generationAccountChanged')
      }
    }
    const result = await (input.target.kind === 'remote'
      ? runRemoteSourceControlPlan({
          plan,
          target: input.target,
          operation: input.operation
        })
      : runLocalPlanForAgent({
          agentId: input.params.agentId,
          plan,
          target: input.target,
          operation: input.operation,
          spawnAgent: input.spawnAgent,
          shouldExecute: input.shouldExecute
        }))
    return input.target.kind === 'local' && input.target.request?.signal.reason === 'deadline'
      ? {
          success: false,
          ...textGenerationFailure('timedOut', {
            seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
          })
        }
      : result
  }
  // Compatibility steps stay bounded per account; each reapplies the account plan and rechecks ownership.
  let result = await runClaudeGenerationAttempts({
    agentId: input.params.agentId,
    run: (attempt): Promise<InternalTextGenerationResult> => {
      if (attempt.strictMcp && !attempt.legacyToolPolicy) {
        return execute(plan)
      }
      const retry = planCommitMessageGeneration(params, input.prompt, attempt)
      return retry.ok
        ? execute(configure ? configure(retry.plan) : retry.plan)
        : Promise.resolve({
            success: false,
            error: retry.error,
            ...textGenerationFailureCodeFields(retry)
          })
    },
    failedExit: (outcome) => (outcome.success ? undefined : outcome.failureOutput)
  })
  if (
    !(input.target.kind === 'local' && input.target.accountAttempt) &&
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
  if (
    input.target.kind === 'local' &&
    (input.target.generationRequest?.canceled ||
      (input.target.request && !(await input.target.request.validate())))
  ) {
    return input.target.request?.signal.reason === 'deadline'
      ? {
          success: false,
          ...textGenerationFailure('timedOut', {
            seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
          })
        }
      : localGenerationCanceledResult()
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
