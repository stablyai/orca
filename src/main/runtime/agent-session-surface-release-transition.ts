// Releasing the lease when the LAST surface lets go of a session.
//
// Every other release in the wire needs a probe, because every other release is about a process
// somebody else started and nobody watched die. This one is different: the host stopped its own
// lease-owning provider root through the adapter. Its observed exit is sufficient because the
// lease follows that root, even when descendants remain `unverifiable`; so is a kill the host
// delivered to the provider itself, which never writes again, released with no exit evidence.
//
// The fence still moves, so the next owner is a new generation: an attach or settlement still
// holding the stopped owner's fence is refused as stale rather than acting on its successor.

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  MAX_AGENT_SESSION_DEATH_DETAIL_CHARS,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
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
  /** Why the provider exited, when the host saw it die on its own. */
  exitReason?: string
  /** The host's kill reached the provider but no exit was seen: nothing to record as evidence,
   *  the same release recovery writes for an owner it could not prove gone. */
  rootExitUnobserved?: true
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (!isSurfaceReleasableAgentSessionRecord(record)) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
  }
  return withLease(record, {
    ...record.lease,
    runtimeFence: nextAgentSessionFence(record.lease),
    ownerProcess: null,
    reservedSpawnToken: null,
    claimStatus: 'released',
    handoffStage: null,
    lastRenewedAt: args.now,
    deathEvidence: args.rootExitUnobserved
      ? null
      : {
          kind: 'exit-observed',
          // A provider's exit reason can carry kilobytes of stderr; a longer detail fails the write.
          detail: args.exitReason
            ? args.exitReason.slice(0, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS)
            : 'the last surface holding this session released it',
          observedAt: args.exitObservedAt ?? args.now,
          ownerFence: record.lease.runtimeFence
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
    exitReason?: string
    rootExitUnobserved?: true
  }
): Promise<AgentSessionRecord> {
  return store.transitionHandoff(args.sessionId, (record) =>
    releaseAgentSessionOwnerAfterSurfaceClose({ ...args, record })
  )
}
