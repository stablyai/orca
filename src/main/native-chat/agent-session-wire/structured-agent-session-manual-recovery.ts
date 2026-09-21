import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import { setStoredAgentSessionHandoffStage } from '../../runtime/agent-session-handoff-record-transitions'
import type { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import { idleStructuredHandoffStatus } from './structured-agent-session-handoff-status'
import type { StructuredAgentSessionHandoffDeps } from './structured-agent-session-handoff-types'

export function structuredManualRecoveryIsAdmissible(
  record: AgentSessionRecord,
  status: AgentSessionHandoffStatus | undefined
): boolean {
  return (
    record.lease.handoffStage === 'manual-recovery' &&
    record.lease.runtimeKind === 'tui' &&
    record.lease.ownerProcess !== null &&
    status?.error?.canRetryProof === true
  )
}

export function beginStructuredManualRecovery(input: {
  deps: StructuredAgentSessionHandoffDeps
  operationGuard: StructuredAgentSessionHandoffOperationGuard
  callerKey: string
  params: AgentSessionHandoffRequest
  fingerprint: string
  requireRecord: (sessionId: string) => AgentSessionRecord
  restore: (sessionId: string) => Promise<void>
  setStatus: (sessionId: string, status: AgentSessionHandoffStatus) => void
}): Promise<void> {
  const {
    callerKey,
    deps,
    fingerprint,
    operationGuard,
    params,
    requireRecord,
    restore,
    setStatus
  } = input
  const sessionId = params.envelope.sessionId
  operationGuard.start(sessionId, {
    callerKey,
    operationId: params.envelope.clientOperationId,
    fingerprint
  })
  setStatus(sessionId, {
    owner: 'none',
    direction: params.direction,
    phase: 'switching',
    stage: 'recovering',
    operationId: params.envelope.clientOperationId,
    hostLabel: deps.transport?.hostLabel
  })
  return deps
    .schedule(sessionId, async () => {
      let record = requireRecord(sessionId)
      if (record.lease.claimStatus === 'reserved' && record.lease.handoffOperationId !== null) {
        record = await setStoredAgentSessionHandoffStage(deps.store, {
          sessionId,
          fence: record.lease.runtimeFence,
          stage: 'new-owner-proving',
          handoffOperationId: record.lease.handoffOperationId,
          now: deps.now()
        })
      }
      await restore(record.sessionId)
      if (requireRecord(sessionId).lease.handoffStage === 'manual-recovery') {
        throw new Error('The TUI owner proof is still unavailable.')
      }
    })
    .then(() => {
      operationGuard.finish(sessionId, params.envelope.clientOperationId)
      return deps.store.recordOperationOutcome({
        callerKey,
        operationId: params.envelope.clientOperationId,
        outcome: { status: 'succeeded', sessionId }
      })
    })
    .catch(async (error) => {
      await deps.store.recordOperationOutcome({
        callerKey,
        operationId: params.envelope.clientOperationId,
        outcome: { status: 'failed', code: 'agent_session_handoff_failed' }
      })
      operationGuard.finish(sessionId, params.envelope.clientOperationId)
      const status = idleStructuredHandoffStatus(requireRecord(sessionId))
      setStatus(sessionId, {
        ...status,
        ...(status.error
          ? {
              error: {
                ...status.error,
                details: error instanceof Error ? error.message : String(error)
              }
            }
          : {})
      })
    })
    .finally(() => operationGuard.finish(sessionId, params.envelope.clientOperationId))
}
