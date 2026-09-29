import { rewindRefusal } from './structured-rewind-refusal'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import {
  agentSessionRefusalFromReference,
  readAgentSessionRefusalReference,
  refuse,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal
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
  recoverUnknownFromDurableState?: boolean
}): AgentSessionReplayOutcomeDecision<TValue> {
  const { operationId, outcome } = input
  if (outcome.status === 'failed') {
    if (outcome.rewindReason) {
      return { decision: 'refuse', refusal: rewindRefusal(outcome.rewindReason).refusal }
    }
    return {
      decision: 'refuse',
      refusal: agentSessionRefusalFromReference(
        recordedRefusal(outcome.code, outcome.details),
        outcome.message ?? `Operation ${operationId} was already refused: ${outcome.code}.`
      )
    }
  }
  if (outcome.status === 'unknown') {
    const recovered = input.recoverUnknownFromDurableState ? input.reconstruct() : null
    if (recovered) {
      return { decision: 'replay', value: recovered }
    }
    if (input.rerunWhenReplayMissing) {
      return { decision: 'rerun' }
    }
    return {
      decision: 'refuse',
      refusal: refuse(
        'agent_session_operation_unknown',
        { reason: 'outcomeUnknown' },
        `The outcome of operation ${operationId} is unknown; it was not run again.`
      )
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
        refusal: refuse(
          'agent_session_operation_unknown',
          { reason: 'resultLost' },
          `Operation ${operationId} succeeded, but its result is no longer reconstructable.`
        )
      }
    : { decision: 'rerun' }
}

/** The refusal a failed row recorded, so a replay says what the first answer said. A code this
 *  build does not know was refused for a reason it cannot name. */
function recordedRefusal(code: string, details: unknown): AgentSessionRefusalReference {
  return (
    readAgentSessionRefusalReference({ code, details }) ?? {
      code: 'agent_session_operation_invalid',
      details: { reason: 'operationRefusedEarlier' }
    }
  )
}
