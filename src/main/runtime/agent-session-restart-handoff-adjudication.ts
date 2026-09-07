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
  if (adjudication.disposition === 'free') {
    return updateLease(record, {
      ...record.lease,
      handoffStage: null,
      handoffOperationId: null,
      processlessAt: null,
      unreconciled: false,
      lastRenewedAt: now
    })
  }
  if (adjudication.disposition !== 'evicted') {
    return updateLease(record, {
      ...record.lease,
      handoffStage:
        adjudication.disposition === 'conflicted' ? 'manual-recovery' : adjudication.stage,
      claimStatus:
        adjudication.disposition === 'conflicted' ? 'conflicted' : record.lease.claimStatus,
      unreconciled: false,
      lastRenewedAt: now
    })
  }
  if (record.lease.handoffStage === 'new-owner-proving' && record.lease.runtimeKind === 'native') {
    // The attempted new owner is proven absent; no writer remains to roll back or readopt.
    return updateLease(record, {
      ...record.lease,
      runtimeFence: adjudication.nextFence,
      handoffStage: null,
      handoffOperationId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      processlessAt: null,
      claimStatus: 'released',
      unreconciled: false,
      lastRenewedAt: now,
      deathEvidence: adjudication.evidence
    })
  }
  const provingTuiTarget =
    record.lease.handoffStage === 'new-owner-proving' && record.lease.runtimeKind === 'tui'
  return updateLease(record, {
    ...record.lease,
    runtimeKind: provingTuiTarget ? 'native' : record.lease.runtimeKind,
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
