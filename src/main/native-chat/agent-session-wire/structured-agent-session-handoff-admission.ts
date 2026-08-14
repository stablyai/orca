import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffResult,
  AgentSessionHandoffStatus,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from '../../../shared/agent-session-wire'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import type { StructuredAgentSessionHandoffDeps } from './structured-agent-session-handoff-types'

export type StructuredHandoffAdmission =
  | { decision: 'continue'; record: AgentSessionRecord; fingerprint: string }
  | { decision: 'replay'; outcome: AgentSessionOperationOutcome }
  | { decision: 'refused'; refusal: AgentSessionWireRefusal }

export async function admitStructuredHandoffRequest(input: {
  deps: StructuredAgentSessionHandoffDeps
  operationGuard: StructuredAgentSessionHandoffOperationGuard
  callerKey: string
  params: AgentSessionHandoffRequest
  record: AgentSessionRecord
  status?: AgentSessionHandoffStatus
}): Promise<StructuredHandoffAdmission> {
  const action = input.params.action ?? 'start'
  const requestFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.requestHandoff',
    sessionId: input.record.sessionId,
    fields: { direction: input.params.direction, mode: input.params.mode, action }
  })
  const conflict = agentSessionFingerprintConflict(input.params.envelope, requestFingerprint)
  if (conflict) {
    return { decision: 'refused', refusal: conflict }
  }
  const fingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.requestHandoff.operation',
    sessionId: input.record.sessionId,
    fields: { direction: input.params.direction }
  })
  const operation = await input.operationGuard.check({
    callerKey: input.callerKey,
    sessionId: input.record.sessionId,
    operationId: input.params.envelope.clientOperationId,
    fingerprint,
    action,
    ...(input.status ? { status: input.status } : {}),
    now: input.deps.now()
  })
  if (operation.decision === 'replay') {
    return { decision: 'replay', outcome: operation.outcome }
  }
  if (operation.decision === 'refused') {
    return {
      decision: 'refused',
      refusal: {
        code: operation.code as 'agent_session_operation_conflict',
        message: 'This handoff operation could not be admitted.'
      }
    }
  }
  if (input.params.envelope.expectedRuntimeFence !== input.record.lease.runtimeFence) {
    await input.deps.store.recordOperationOutcome({
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: { status: 'failed', code: 'agent_session_checkpoint_stale' }
    })
    input.operationGuard.finish(input.record.sessionId, input.params.envelope.clientOperationId)
    return {
      decision: 'refused',
      refusal: {
        code: 'agent_session_checkpoint_stale',
        message: 'The session owner changed before the handoff request arrived.',
        currentFence: input.record.lease.runtimeFence
      }
    }
  }
  return { decision: 'continue', record: input.record, fingerprint }
}

export function replayedStructuredHandoffRefusal(
  outcome: AgentSessionOperationOutcome
): AgentSessionWireRefusal | null {
  if (
    outcome.status !== 'failed' ||
    !AGENT_SESSION_WIRE_REFUSAL_CODES.includes(
      outcome.code as (typeof AGENT_SESSION_WIRE_REFUSAL_CODES)[number]
    )
  ) {
    return null
  }
  return {
    code: outcome.code as (typeof AGENT_SESSION_WIRE_REFUSAL_CODES)[number],
    message: 'This handoff request was previously refused.'
  }
}

export async function refuseAdmittedStructuredHandoff(input: {
  deps: StructuredAgentSessionHandoffDeps
  callerKey: string
  params: AgentSessionHandoffRequest
  refusal: AgentSessionWireRefusal
}): Promise<AgentSessionMutationResult<AgentSessionHandoffResult>> {
  await input.deps.store.recordOperationOutcome({
    callerKey: input.callerKey,
    operationId: input.params.envelope.clientOperationId,
    outcome: { status: 'failed', code: input.refusal.code }
  })
  return { ok: false, refusal: input.refusal }
}

export function structuredHandoffRetryIsAdmissible(
  status: AgentSessionHandoffStatus,
  params: AgentSessionHandoffRequest
): boolean {
  return (
    status.phase === 'failed' &&
    status.direction === params.direction &&
    status.operationId === params.envelope.clientOperationId &&
    status.error?.recoverableOwner !== 'none'
  )
}

export function structuredHandoffRetryResumesStoppedOwner(
  record: AgentSessionRecord,
  params: AgentSessionHandoffRequest
): boolean {
  return (
    record.lease.claimStatus === 'released' &&
    record.lease.handoffStage === 'old-owner-stopped' &&
    record.lease.handoffOperationId === params.envelope.clientOperationId
  )
}
