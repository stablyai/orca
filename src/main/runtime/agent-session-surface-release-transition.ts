// Releasing the lease when the LAST surface lets go of a session.
//
// Every other release in the wire needs a probe, because every other release is about a process
// somebody else started and nobody watched die. This one is different: the host stopped its own
// lease-owning provider root through the adapter. Its observed exit is sufficient because the
// lease follows that root, even when descendants remain `unverifiable`.
//
// The fence still moves. A released lease at the old fence would let a mutation a client queued
// against the dead generation land on the next one.

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import { assertFence, withLease } from './agent-session-lease-transitions'
import type { AgentSessionRecordStore } from './agent-session-record-store'

export type AgentSessionRecordTransitionStore = Pick<AgentSessionRecordStore, 'transitionHandoff'>

/** Whether this record is one THIS host may release on its own proof. A session mid-handoff and a
 *  lease nobody holds are somebody else's transition. */
export function isSurfaceReleasableAgentSessionRecord(record: AgentSessionRecord): boolean {
  return (
    record.lease.claimStatus === 'live' &&
    record.lease.handoffStage === null &&
    record.lease.ownerProcess !== null
  )
}

export function releaseAgentSessionOwnerAfterSurfaceClose(args: {
  record: AgentSessionRecord
  expectedFence: number
  now: number
  /** Exit receipt can precede a delayed journal settlement and lease release. */
  exitObservedAt?: number
  settlementRetry?: { settlementId: string; detail: string }
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (!isSurfaceReleasableAgentSessionRecord(record)) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    runtimeFence: nextAgentSessionFence(record.lease),
    ownerProcess: null,
    reservedSpawnToken: null,
    processlessAt: null,
    claimStatus: 'released',
    handoffStage: args.settlementRetry ? 'recovering' : null,
    settlementRetryRequired: args.settlementRetry ? true : undefined,
    settlementRetryId: args.settlementRetry?.settlementId,
    lastRenewedAt: args.now,
    deathEvidence: {
      kind: 'exit-observed',
      detail: args.settlementRetry?.detail ?? 'the last surface holding this session released it',
      observedAt: args.exitObservedAt ?? args.now
    }
  })
}

/** Applied through the store's generic transition, the same way handoff records move. */
export function releaseStoredAgentSessionOwnerAfterSurfaceClose(
  store: AgentSessionRecordTransitionStore,
  args: {
    sessionId: string
    expectedFence: number
    now: number
    exitObservedAt?: number
    settlementRetry?: { settlementId: string; detail: string }
  }
): Promise<AgentSessionRecord> {
  return store.transitionHandoff(args.sessionId, (record) =>
    releaseAgentSessionOwnerAfterSurfaceClose({ ...args, record })
  )
}
