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
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { withLease } from './agent-session-lease-transitions'

/** Apply one restart adjudication. Never consults deadlines — only proof moves a lease. */
export function applyAgentSessionRestartAdjudication(args: {
  record: AgentSessionRecord
  probe: AgentSessionOwnerProbe
  now: number
}): AgentSessionRecord {
  const { record } = args
  const adjudication = adjudicateAgentSessionRestart({
    lease: record.lease,
    probe: args.probe,
    observedAt: args.now
  })
  if (adjudication.disposition === 'free') {
    // Why: an already-free lease that reloads into `recovering` is unopenable forever; clearing
    // the stage restores it without moving the fence or touching the recorded death evidence.
    return withLease(record, {
      ...record.lease,
      handoffStage: null,
      handoffOperationId: null,
      unreconciled: false,
      lastRenewedAt: args.now
    })
  }
  if (adjudication.disposition === 'evicted') {
    // What the dead generation left running is settled from `deathEvidence` when the journal is
    // next opened, so nothing about it is owed here.
    return withLease(record, {
      ...record.lease,
      runtimeFence: adjudication.nextFence,
      handoffStage: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released',
      unreconciled: false,
      lastRenewedAt: args.now,
      handoffOperationId: null,
      deathEvidence: adjudication.evidence
    })
  }
  return withLease(record, {
    ...record.lease,
    handoffStage: adjudication.stage,
    unreconciled: false,
    lastRenewedAt: args.now
  })
}
