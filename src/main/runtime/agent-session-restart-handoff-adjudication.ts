import {
  adjudicateAgentSessionRestart,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

export function adjudicateRestartedAgentSessionHandoff(
  record: AgentSessionRecord,
  probe: AgentSessionOwnerProbe,
  now: number
): AgentSessionRecord {
  const adjudication = adjudicateAgentSessionRestart({
    lease: record.lease,
    probe,
    observedAt: now
  })
  if (adjudication.disposition === 'readopt') {
    return updateLease(record, { ...record.lease, unreconciled: false, lastRenewedAt: now })
  }
  if (adjudication.disposition !== 'evicted') {
    return updateLease(record, {
      ...record.lease,
      handoffStage: 'recovering',
      claimStatus:
        adjudication.disposition === 'conflicted' ? 'conflicted' : record.lease.claimStatus,
      unreconciled: false,
      lastRenewedAt: now
    })
  }
  const provingTarget = record.lease.handoffStage === 'new-owner-proving'
  return updateLease(record, {
    ...record.lease,
    runtimeKind: provingTarget
      ? record.lease.runtimeKind === 'native'
        ? 'tui'
        : 'native'
      : record.lease.runtimeKind,
    runtimeFence: adjudication.nextFence,
    handoffStage: 'old-owner-stopped',
    ownerProcess: null,
    reservedSpawnToken: null,
    processlessAt: null,
    claimStatus: 'released',
    unreconciled: false,
    lastRenewedAt: now,
    deathEvidence: adjudication.evidence
  })
}

function updateLease(record: AgentSessionRecord, lease: AgentSessionRecord['lease']) {
  return { ...record, lease, updatedAt: lease.lastRenewedAt }
}
