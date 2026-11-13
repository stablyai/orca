import type { AgentSessionAdvisoryPolicy } from '../../../shared/agent-session/agent-session-advisory-policy'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../shared/agent-session/agent-session-advisory-policy'
import {
  agentSessionAdvisoryUsageSchema,
  type AgentSessionAdvisoryObservation,
  type AgentSessionAdvisoryReceipt
} from '../../../shared/agent-session/agent-session-advisory-receipt'
import type { readClaudeAdvisoryBinding } from './claude-advisory-binding'
import { record } from './launch/claude-structured-model-catalog'

export function createClaudeAdvisoryObservation(
  policy: AgentSessionAdvisoryPolicy,
  publish: (value: AgentSessionAdvisoryObservation) => void,
  stop: (error?: Error) => void
) {
  let binding: ReturnType<typeof readClaudeAdvisoryBinding> = null
  let hooksApplied = false,
    inputAdmitted = false,
    invalidated = false,
    turnCompleted = false,
    reported = false
  let observedAt = Date.now(),
    responseModel: string | null = null
  let usage: AgentSessionAdvisoryReceipt['execution']['usage']
  let closure: AgentSessionAdvisoryReceipt['closure']
  const responses = new Set<string>()
  const emit = () => {
    if (policy.schema !== 2) {
      return
    }
    publish({
      version: 1,
      invalidated,
      turnCompleted,
      ...(closure ? { closure } : {}),
      execution: {
        agent: 'claude',
        observedAt,
        binding,
        responseModel,
        bounded: {
          policyFingerprint: agentSessionAdvisoryPolicyFingerprint(policy),
          deadlineAt: policy.deadlineAt,
          maxModelCalls: policy.maxModelCalls,
          modelCalls: responses.size,
          inputAdmitted,
          hooksApplied,
          callCounter: 'main-assistant-message-ids'
        },
        ...(usage ? { usage } : {})
      }
    })
  }
  const fail = (message: string) => {
    invalidated = true
    emit()
    stop(new Error(message))
  }
  return {
    binding: (value: ReturnType<typeof readClaudeAdvisoryBinding>, hooks: boolean) => {
      if (closure) {
        return
      }
      binding = value
      hooksApplied = hooks
      observedAt = Date.now()
      emit()
    },
    admitted: () => {
      inputAdmitted = true
      emit()
    },
    reported: () => {
      reported = true
      emit()
    },
    invalidate: () => {
      if (!invalidated) {
        invalidated = true
        emit()
      }
    },
    closure: (value: NonNullable<AgentSessionAdvisoryReceipt['closure']>) => {
      closure = value
      emit()
    },
    message: (message: Record<string, unknown>) => {
      if (policy.schema !== 2) {
        return
      }
      if (message.type === 'assistant') {
        const body = record(message.message)
        if (
          !body ||
          typeof body.id !== 'string' ||
          !body.id ||
          message.parent_tool_use_id != null
        ) {
          fail('Advisor response identity unproven.')
          return
        }
        responses.add(body.id)
        responseModel = typeof body.model === 'string' ? body.model : null
        if (
          !inputAdmitted ||
          responses.size > policy.maxModelCalls ||
          responseModel !== policy.binding.model
        ) {
          fail('Advisor response exceeded or changed its admitted binding.')
          return
        }
        emit()
      }
      if (message.type === 'result') {
        const models = record(message.modelUsage)
        const parsed = agentSessionAdvisoryUsageSchema.safeParse({
          scope: 'query-pipeline',
          auxiliaryCoverage: 'partial',
          observedAt: Date.now(),
          models: models
            ? Object.entries(models).map(([model, value]) => {
                const source = record(value)
                return source
                  ? {
                      model,
                      inputTokens: source.inputTokens,
                      outputTokens: source.outputTokens,
                      cacheReadInputTokens: source.cacheReadInputTokens,
                      cacheCreationInputTokens: source.cacheCreationInputTokens,
                      ...(source.thinkingTokens !== undefined
                        ? { thinkingTokens: source.thinkingTokens }
                        : {})
                    }
                  : null
              })
            : null
        })
        usage = parsed.success && parsed.data.models.length ? parsed.data : undefined
        turnCompleted =
          message.subtype === 'success' || (reported && message.subtype === 'error_max_turns')
        if (!turnCompleted || !reported || responses.size === 0) {
          invalidated = true
        }
        emit()
        stop()
      }
    }
  }
}
