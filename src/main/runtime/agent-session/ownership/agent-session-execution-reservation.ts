import { agentSessionExecutionPolicySchema } from '../../../../shared/agent-session/agent-session-execution-policy'
import { agentSessionNeverStarted } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

function refuse(): never {
  throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'requestMalformed' })
}

export function validateExecutionReservationInput(request: AgentSessionReserveRequest): void {
  const policy = request.executionPolicy
  if (
    policy &&
    (!agentSessionExecutionPolicySchema.safeParse(policy).success ||
      request.advisoryPolicy ||
      request.provider !== 'codex' ||
      request.location.executionHostId !== 'local' ||
      request.location.wslDistro !== null ||
      request.location.workspaceKind !== 'folder' ||
      policy.deadlineAt <= request.now ||
      policy.deadlineAt - request.now > 300_000 ||
      request.options?.model !== policy.model ||
      request.options?.effort !== policy.effort ||
      request.adoptedHandleLink ||
      request.forkedFrom)
  ) {
    refuse()
  }
}

export function admitExecutionOwnerReservation(
  existing: AgentSessionRecord,
  request: AgentSessionReserveRequest
): void {
  if (
    request.executionPolicy &&
    JSON.stringify(request.executionPolicy) !== JSON.stringify(existing.executionPolicy)
  ) {
    refuse()
  }
  if (
    existing.executionPolicy &&
    (!agentSessionNeverStarted(existing) ||
      existing.executionPolicy.deadlineAt <= request.now ||
      existing.executionPolicy.deadlineAt - request.now > 300_000)
  ) {
    refuse()
  }
}
