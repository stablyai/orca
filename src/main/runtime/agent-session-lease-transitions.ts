/**
 * Pure lease state transitions. Every function returns the next record or throws a typed error;
 * the store applies them inside one durable transaction so a rejected transition never lands.
 *
 * The invariant they exist to enforce: a session admits a writer only after a reservation, an
 * observed process identity, and a proved provider handle — in that order, at one fence.
 */

import {
  adjudicateAgentSessionRestart,
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import {
  appendAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type {
  AgentSessionJournalCheckpoint,
  AgentSessionHandoffStage,
  AgentSessionLease,
  AgentSessionOwnerRuntimeKind,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'

export type AgentSessionReservation = {
  runtimeKind: AgentSessionOwnerRuntimeKind
  spawnToken: string
  claimKeyId: string
  handoffOperationId: string | null
  leaseTtlMs: number
  now: number
}

export function withLease(
  record: AgentSessionRecord,
  lease: AgentSessionLease
): AgentSessionRecord {
  return { ...record, lease, updatedAt: lease.lastRenewedAt }
}

export function assertFence(lease: AgentSessionLease, fence: number): void {
  if (lease.runtimeFence !== fence) {
    throw new Error('agent_session_checkpoint_stale')
  }
  if (lease.unreconciled) {
    throw new Error('execution_owner_reconciling')
  }
}

/**
 * Compare-and-swap reservation. Writes the intent at fence + 1 before any process exists, so the
 * loser of a concurrent swap is refused and never spawns.
 */
export function reserveAgentSessionOwner(args: {
  record: AgentSessionRecord
  expectedFence: number
  probe: AgentSessionOwnerProbe
  reservation: AgentSessionReservation
}): { record: AgentSessionRecord; disposition: 'reserved' | 'retry-reservation' } {
  const { record, reservation } = args
  const decision = evaluateAgentSessionAcquisition({
    lease: record.lease,
    expectedFence: args.expectedFence,
    handoffOperationId: reservation.handoffOperationId,
    probe: args.probe
  })
  if (decision.decision === 'refused') {
    throw new Error(decision.code)
  }
  if (decision.decision === 'retry-reservation') {
    return { record, disposition: 'retry-reservation' }
  }
  return {
    disposition: 'reserved',
    record: withLease(record, {
      ...record.lease,
      runtimeKind: reservation.runtimeKind,
      runtimeFence: decision.nextFence,
      // Why: a reserved owner is not yet a writer; it may only talk to the provider to prove resume.
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: reservation.spawnToken,
      processlessAt: null,
      leaseDeadlineAt: reservation.now + reservation.leaseTtlMs,
      lastRenewedAt: reservation.now,
      handoffOperationId: reservation.handoffOperationId,
      claimKeyId: reservation.claimKeyId,
      claimStatus: 'reserved',
      settlementRetryRequired: undefined,
      settlementRetryId: undefined,
      deathEvidence: null
    })
  }
}

/** Step 4 of acquisition: write the observed identity back into the same lease row. */
export type AgentSessionProcessIdentityCommit = {
  sessionId: string
  fence: number
  process: AgentSessionProcessIdentity
  now: number
}

export function commitAgentSessionProcessIdentity(
  args: AgentSessionProcessIdentityCommit & { record: AgentSessionRecord }
): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.fence)
  if (record.lease.claimStatus !== 'reserved' || record.lease.ownerProcess !== null) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (record.lease.reservedSpawnToken !== args.process.spawnToken) {
    // Why: a child that cannot echo the reserved token is not the process Orca started.
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    ownerProcess: args.process,
    processlessAt: null,
    lastRenewedAt: args.now
  })
}

/**
 * The new runtime proved it resumed the expected provider handle. Only now does the session have
 * a writer.
 */
export function proveAgentSessionOwner(args: {
  record: AgentSessionRecord
  fence: number
  link: AgentSessionProviderHandleLink
  now: number
  leaseTtlMs: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.fence)
  if (
    record.lease.claimStatus !== 'reserved' ||
    record.lease.handoffStage !== 'new-owner-proving' ||
    record.lease.ownerProcess === null
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (args.link.handle.provider !== record.provider) {
    throw new Error('agent_session_provider_handle_provider_mismatch')
  }
  if (args.link.mintedAtFence !== args.fence) {
    throw new Error('agent_session_provider_handle_stale_fence')
  }
  const providerHandleChain = appendAgentSessionProviderHandleLink(
    record.providerHandleChain,
    args.link
  )
  const head = providerHandleChain.at(-1)
  if (!head) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return {
    ...record,
    providerHandleChain,
    lease: {
      ...record.lease,
      handoffStage: null,
      provenHandleLinkId: head.linkId,
      claimStatus: 'live',
      leaseDeadlineAt: args.now + args.leaseTtlMs,
      lastRenewedAt: args.now,
      handoffOperationId: null
    },
    updatedAt: args.now
  }
}

/**
 * A renewal asserts two things at once: the host is running its loop, and the child still matches
 * the recorded identity. A host that cannot re-verify the child stops renewing rather than
 * extending a lease it can no longer vouch for.
 */
export function renewAgentSessionLease(args: {
  record: AgentSessionRecord
  fence: number
  childProbe: AgentSessionOwnerProbe
  now: number
  leaseTtlMs: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.fence)
  if (record.lease.ownerProcess === null) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (args.childProbe.outcome !== 'identity-matched' || args.childProbe.matchedOn.length === 0) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    leaseDeadlineAt: args.now + args.leaseTtlMs,
    lastRenewedAt: args.now
  })
}

/** Proven eviction — the only other thing besides acquisition that may move the fence. */
export function evictAgentSessionOwner(args: {
  record: AgentSessionRecord
  expectedFence: number
  probe: AgentSessionOwnerProbe
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (record.lease.settlementRetryRequired) {
    throw new Error('agent_session_ownership_unknown')
  }
  const adjudication = adjudicateAgentSessionRestart({
    lease: record.lease,
    probe: args.probe,
    observedAt: args.now
  })
  if (adjudication.disposition === 'free') {
    // Nothing outstanding to evict; clearing the latched stage IS the resolution, and no new
    // generation was granted, so the fence and the recorded evidence both stay put.
    return withLease(record, {
      ...record.lease,
      handoffStage: null,
      handoffOperationId: null,
      processlessAt: null,
      lastRenewedAt: args.now
    })
  }
  if (adjudication.disposition !== 'evicted') {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    runtimeFence: adjudication.nextFence,
    handoffStage: null,
    ownerProcess: null,
    reservedSpawnToken: null,
    processlessAt: null,
    claimStatus: 'released',
    lastRenewedAt: args.now,
    handoffOperationId: null,
    deathEvidence: adjudication.evidence
  })
}

export function setAgentSessionHandoffStage(args: {
  record: AgentSessionRecord
  fence: number
  stage: AgentSessionHandoffStage | null
  handoffOperationId: string | null
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.fence)
  if (
    record.lease.handoffOperationId !== null &&
    args.handoffOperationId !== null &&
    args.handoffOperationId !== record.lease.handoffOperationId
  ) {
    throw new Error('agent_session_operation_conflict')
  }
  return withLease(record, {
    ...record.lease,
    handoffStage: args.stage,
    handoffOperationId: args.handoffOperationId,
    lastRenewedAt: args.now
  })
}

export function setAgentSessionJournalCheckpoint(args: {
  record: AgentSessionRecord
  fence: number
  checkpoint: AgentSessionJournalCheckpoint
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.fence)
  const current = record.lease.journalCheckpoint
  if (
    current &&
    (current.epoch > args.checkpoint.epoch ||
      (current.epoch === args.checkpoint.epoch && current.sequence > args.checkpoint.sequence))
  ) {
    throw new Error('agent_session_checkpoint_stale')
  }
  return withLease(record, {
    ...record.lease,
    journalCheckpoint: args.checkpoint,
    lastRenewedAt: args.now
  })
}
