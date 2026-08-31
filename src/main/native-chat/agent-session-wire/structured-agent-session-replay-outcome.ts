import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire'

export type AgentSessionReplayOutcomeDecision<TValue> =
  | { decision: 'replay'; value: TValue }
  | { decision: 'rerun' }
  | { decision: 'refuse'; refusal: AgentSessionWireRefusal }

export function resolveAgentSessionReplayOutcome<TValue>(input: {
  operationId: string
  outcome: AgentSessionOperationOutcome
  reconstruct: () => TValue | null
  rerunWhenReplayMissing?: boolean
}): AgentSessionReplayOutcomeDecision<TValue> {
  const { operationId, outcome } = input
  if (outcome.status === 'failed') {
    const code = (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(outcome.code)
      ? (outcome.code as AgentSessionWireRefusalCode)
      : 'agent_session_operation_invalid'
    return {
      decision: 'refuse',
      refusal: {
        code,
        message: outcome.message ?? `Operation ${operationId} was already refused: ${outcome.code}.`
      }
    }
  }
  if (outcome.status === 'unknown') {
    if (input.rerunWhenReplayMissing) {
      return { decision: 'rerun' }
    }
    return {
      decision: 'refuse',
      refusal: {
        code: 'agent_session_operation_unknown',
        message: `The outcome of operation ${operationId} is unknown; it was not run again.`
      }
    }
  }
  const recorded = input.reconstruct()
  if (recorded) {
    return { decision: 'replay', value: recorded }
  }
  if (input.rerunWhenReplayMissing) {
    return { decision: 'rerun' }
  }
  return outcome.status === 'succeeded'
    ? {
        decision: 'refuse',
        refusal: {
          code: 'agent_session_operation_unknown',
          message: `Operation ${operationId} succeeded, but its result is no longer reconstructable.`
        }
      }
    : { decision: 'rerun' }
}
