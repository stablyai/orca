// Release only this host’s child with observed/proven exit; read-only or TUI ownership
// proves no exit and must never admit a second writer.

import {
  isSurfaceReleasableAgentSessionRecord,
  releaseStoredAgentSessionOwnerAfterSurfaceClose
} from '../../runtime/agent-session/ownership/agent-session-surface-release-transition'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAgentSessionLeaseStore = Pick<
  AgentSessionRecordStore,
  'getRecord' | 'transitionHandoff'
>

/** Release the observed child; throw agent_session_checkpoint_stale if ownership changed. */
export async function releaseStoredStructuredAgentSessionOwnerAfterExit(input: {
  store: StructuredAgentSessionLeaseStore
  sessionId: string
  expectedFence: number
  now: number
  exitObservedAt?: number
  exitReason?: string
}): Promise<AgentSessionRecord> {
  const record = input.store.getRecord(input.sessionId)
  if (
    !record ||
    record.lease.runtimeFence !== input.expectedFence ||
    !isSurfaceReleasableAgentSessionRecord(record)
  ) {
    throw new Error('agent_session_checkpoint_stale')
  }
  return releaseStoredAgentSessionOwnerAfterSurfaceClose(input.store, {
    sessionId: input.sessionId,
    expectedFence: input.expectedFence,
    now: input.now,
    ...(input.exitObservedAt === undefined ? {} : { exitObservedAt: input.exitObservedAt }),
    ...(input.exitReason ? { exitReason: input.exitReason } : {})
  })
}
