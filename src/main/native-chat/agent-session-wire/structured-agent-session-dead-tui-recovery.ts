import { randomUUID } from 'node:crypto'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { recoverStoredDeadTuiOwnerForHandoff } from '../../runtime/agent-session-handoff-record-transitions'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { idleStructuredHandoffStatus } from './structured-agent-session-handoff-status'

export async function recoverDeadTuiHandoffStatus(input: {
  store: AgentSessionRecordStore
  now: () => number
  record: AgentSessionRecord
  expectedFence: number
  probe: AgentSessionOwnerProbe
}): Promise<AgentSessionHandoffStatus | null> {
  const { expectedFence, now, probe, record, store } = input
  if (
    record.lease.runtimeFence !== expectedFence ||
    record.lease.runtimeKind !== 'tui' ||
    record.lease.handoffStage !== null ||
    record.lease.claimStatus !== 'live' ||
    record.lease.ownerProcess === null
  ) {
    return null
  }
  const recovered = await recoverStoredDeadTuiOwnerForHandoff(store, {
    sessionId: record.sessionId,
    expectedFence,
    operationId: createStructuredAgentSessionOperationId(randomUUID, now()),
    probe,
    now: now()
  })
  return idleStructuredHandoffStatus(recovered)
}
