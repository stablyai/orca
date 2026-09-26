import { rewindRefusal } from './structured-rewind-refusal'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import {
  isAgentSessionRefusalCause,
  isAgentSessionWireRefusalCode,
  refuse,
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
    const code = isAgentSessionWireRefusalCode(outcome.code)
      ? outcome.code
      : 'agent_session_operation_invalid'
    // The recorded situation, so a replay says what the first answer said; a code this build does
    // not know was refused for a reason it cannot name.
    const cause =
      code !== outcome.code
        ? 'operationRefusedEarlier'
        : isAgentSessionRefusalCause(outcome.cause)
          ? outcome.cause
          : undefined
    return {
      decision: 'refuse',
      refusal: {
        code,
        ...(cause ? { cause } : {}),
        message: outcome.message ?? `Operation ${operationId} was already refused: ${outcome.code}.`
      }
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
        'outcomeUnknown',
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
          'resultLost',
          `Operation ${operationId} succeeded, but its result is no longer reconstructable.`
        )
      }
    : { decision: 'rerun' }
}
