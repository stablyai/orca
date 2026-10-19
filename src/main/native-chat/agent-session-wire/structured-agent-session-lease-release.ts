// Handing the durable lease back once this host's own provider child is gone.
//
// Only an exit this host saw or proved, of the child it started at this fence, may release: a
// session restored only for reading, or one a TUI owns, names an owner process this host never
// started and may still be alive. Writing `exit-observed` against that record would release a lease
// out from under a running process and let a second writer in.

import {
  isSurfaceReleasableAgentSessionRecord,
  releaseStoredAgentSessionOwnerAfterSurfaceClose
} from '../../runtime/agent-session-surface-release-transition'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAgentSessionLeaseStore = Pick<
  AgentSessionRecordStore,
  'getRecord' | 'transitionHandoff'
>

/** Releases the lease of the child whose exit this host observed, with that exit's evidence.
 *  Throws `agent_session_checkpoint_stale` when the record no longer names that child. */
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
