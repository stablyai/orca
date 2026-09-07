/**
 * Turning a restart adjudication into the next record.
 *
 * Applies one restart verdict to one loaded lease. Kept apart from the acquisition transitions
 * because it is the only one that moves a lease WITHOUT a new owner proving anything — which is
 * exactly the polarity that has to be read carefully.
 */

import {
  adjudicateAgentSessionRestart,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionHandoffStage,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { adjudicateRestartedAgentSessionHandoff } from './agent-session-restart-handoff-adjudication'
import { withLease } from './agent-session-lease-transitions'

/** Apply one restart adjudication. Never consults deadlines — only proof moves a lease. */
export function applyAgentSessionRestartAdjudication(args: {
  record: AgentSessionRecord
  probe: AgentSessionOwnerProbe
  now: number
}): AgentSessionRecord {
  const { record } = args
  if (
    record.lease.handoffStage === 'old-owner-stopped' &&
    record.lease.claimStatus === 'released' &&
    record.lease.ownerProcess === null
  ) {
    return withLease(record, {
      ...record.lease,
      unreconciled: false,
      lastRenewedAt: args.now
    })
  }
  if (
    record.lease.handoffStage === 'preparing' ||
    record.lease.handoffStage === 'new-owner-proving'
  ) {
    return adjudicateRestartedAgentSessionHandoff(record, args.probe, args.now)
  }
  const adjudication = adjudicateAgentSessionRestart({
    lease: record.lease,
    probe: args.probe,
    observedAt: args.now
  })
  if (adjudication.disposition === 'readopt') {
    // Why: re-adoption is not a new generation, so the fence does not move.
    return withLease(record, { ...record.lease, unreconciled: false, lastRenewedAt: args.now })
  }
  if (adjudication.disposition === 'free') {
    // Why: an already-free lease that reloads into `recovering` is unopenable forever; clearing
    // the stage restores it without moving the fence or touching the recorded death evidence.
    return withLease(record, {
      ...record.lease,
      handoffStage: null,
      handoffOperationId: null,
      processlessAt: null,
      unreconciled: false,
      lastRenewedAt: args.now
    })
  }
  if (adjudication.disposition === 'evicted') {
    return withLease(record, {
      ...record.lease,
      runtimeFence: adjudication.nextFence,
      handoffStage: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      processlessAt: null,
      claimStatus: 'released',
      unreconciled: false,
      lastRenewedAt: args.now,
      handoffOperationId: null,
      deathEvidence: adjudication.evidence
    })
  }
  const stage: AgentSessionHandoffStage =
    adjudication.disposition === 'conflicted' ? 'manual-recovery' : adjudication.stage
  return withLease(record, {
    ...record.lease,
    handoffStage: stage,
    claimStatus:
      adjudication.disposition === 'conflicted' ? 'conflicted' : record.lease.claimStatus,
    unreconciled: false,
    lastRenewedAt: args.now
  })
}
