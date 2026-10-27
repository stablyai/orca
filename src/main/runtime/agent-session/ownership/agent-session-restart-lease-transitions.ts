/** Apply restart verdicts to loaded leases without a newly proving owner; evidence, never deadlines, governs release. */

import {
  adjudicateAgentSessionRestart,
  type AgentSessionOwnerProbe
} from '../../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { withLease } from './agent-session-lease-transitions'

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
    // Clearing recovery on an already-free lease restores access without moving its fence or death proof.
    return withLease(record, {
      ...record.lease,
      handoffStage: null,
      handoffOperationId: null,
      unreconciled: false,
      lastRenewedAt: args.now
    })
  }
  if (adjudication.disposition === 'evicted') {
    // Journal reopening settles dead-generation work from persisted deathEvidence.
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
  // Recovery is not new liveness proof; preserve the pre-crash renewal.
  return {
    ...withLease(record, {
      ...record.lease,
      handoffStage: adjudication.stage,
      unreconciled: false
    }),
    updatedAt: args.now
  }
}
