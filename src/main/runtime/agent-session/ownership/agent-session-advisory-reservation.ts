import { agentSessionAdvisoryPolicySchema } from '../../../../shared/agent-session/agent-session-advisory-policy'
import { agentSessionNeverStarted } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

export function validateAdvisoryReservationInput(request: AgentSessionReserveRequest): void {
  if (
    request.advisoryPolicy !== undefined &&
    (!agentSessionAdvisoryPolicySchema.safeParse(request.advisoryPolicy).success ||
      request.advisoryPolicy.deadlineAt <= request.now ||
      request.advisoryPolicy.deadlineAt - request.now > 300_000 ||
      request.adoptedHandleLink ||
      request.forkedFrom)
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
}

export function admitAdvisoryOwnerReservation(
  existing: AgentSessionRecord,
  request: AgentSessionReserveRequest
): void {
  const requested =
    request.advisoryPolicy === undefined
      ? null
      : agentSessionAdvisoryPolicySchema.safeParse(request.advisoryPolicy)
  if (
    requested &&
    (!requested.success ||
      JSON.stringify(requested.data) !== JSON.stringify(existing.advisoryPolicy))
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'advisoryPolicyMismatch'
    })
  }
  if (!existing.advisoryPolicy) {
    return
  }
  if (!agentSessionNeverStarted(existing)) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'advisoryAlreadyStarted'
    })
  }
  if (
    existing.advisoryPolicy.deadlineAt <= request.now ||
    existing.advisoryPolicy.deadlineAt - request.now > 300_000
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'advisoryDeadlinePassed'
    })
  }
}
