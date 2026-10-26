// Last-surface close may release this host's provider root on observed exit, even with unverifiable descendants.
// This proves root exit, not tree death; advance the fence to reject the stopped owner's late effects.

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  MAX_AGENT_SESSION_DEATH_DETAIL_CHARS,
  type AgentSessionRecord
} from '../../../../shared/agent-session-record'
import { nextAgentSessionFence } from '../../../../shared/agent-session-next-fence'
import { assertFence, withLease } from './agent-session-lease-transitions'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'

export type AgentSessionRecordTransitionStore = Pick<AgentSessionRecordStore, 'transitionHandoff'>

/** Only this host's owned lease is releasable; handoffs and free leases use other transitions. */
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
  exitReason?: string
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
    deathEvidence: {
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

export function releaseStoredAgentSessionOwnerAfterSurfaceClose(
  store: AgentSessionRecordTransitionStore,
  args: {
    sessionId: string
    expectedFence: number
    now: number
    exitObservedAt?: number
    exitReason?: string
  }
): Promise<AgentSessionRecord> {
  return store.transitionHandoff(args.sessionId, (record) =>
    releaseAgentSessionOwnerAfterSurfaceClose({ ...args, record })
  )
}
