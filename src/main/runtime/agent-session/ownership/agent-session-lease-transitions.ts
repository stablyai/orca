/** Pure transitions applied by the store in one durable transaction.
 * Writer admission requires reservation, observed process identity and provider-handle proof at one fence. */

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  adjudicateAgentSessionRestart,
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from '../../../../shared/agent-session-lease-adjudication'
import {
  appendAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../../../shared/agent-session-provider-handle'
import { agentSessionProviderHandleBelongsTo } from '../../../../shared/agent-session-provider-handle-encoding'
import { nextAgentSessionFence } from '../../../../shared/agent-session-next-fence'
import type {
  AgentSessionDeathEvidence,
  AgentSessionLease,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../../shared/agent-session-record'

export type AgentSessionReservation = {
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
    throw agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'leaseMoved' })
  }
  if (lease.unreconciled) {
    throw agentSessionRefusalError('execution_owner_reconciling', { reason: 'hostReconciling' })
  }
}

/** Reserve fence + 1 before spawn; concurrent losers cannot start a process. */
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
    throw agentSessionRefusalError(decision.code, decision.details)
  }
  if (decision.decision === 'retry-reservation') {
    return { record, disposition: 'retry-reservation' }
  }
  return {
    disposition: 'reserved',
    record: withLease(record, {
      ...record.lease,
      runtimeKind: 'native',
      runtimeFence: decision.nextFence,
      // Reservations may prove provider resume, never perform writer effects.
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: reservation.spawnToken,
      leaseDeadlineAt: reservation.now + reservation.leaseTtlMs,
      lastRenewedAt: reservation.now,
      handoffOperationId: reservation.handoffOperationId,
      claimKeyId: reservation.claimKeyId,
      claimStatus: 'reserved',
      deathEvidence: null
    })
  }
}

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
    throw agentSessionRefusalError('agent_session_ownership_unknown', {
      reason: 'spawnIdentityMismatch'
    })
  }
  if (record.lease.reservedSpawnToken !== args.process.spawnToken) {
    // The child must echo this reservation's token to prove Orca started it.
    throw agentSessionRefusalError('agent_session_ownership_unknown', {
      reason: 'spawnIdentityMismatch'
    })
  }
  return withLease(record, {
    ...record.lease,
    ownerProcess: args.process,
    lastRenewedAt: args.now
  })
}

/** Admit the proven owner; record a supplied provider link now or leave it unproven until the adapter reports one. */
export function proveAgentSessionOwner(args: {
  record: AgentSessionRecord
  fence: number
  link?: AgentSessionProviderHandleLink
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
    throw agentSessionRefusalError('agent_session_ownership_unknown', {
      reason: 'spawnIdentityMismatch'
    })
  }
  const { link } = args
  if (link && !agentSessionProviderHandleBelongsTo(link.handle, record.provider)) {
    throw new Error('agent_session_provider_handle_provider_mismatch')
  }
  if (link && link.mintedAtFence !== args.fence) {
    throw new Error('agent_session_provider_handle_stale_fence')
  }
  const providerHandleChain = link
    ? appendAgentSessionProviderHandleLink(record.providerHandleChain, link)
    : record.providerHandleChain
  const head = providerHandleChain.at(-1)
  if (link && !head) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return {
    ...record,
    providerHandleChain,
    lease: {
      ...record.lease,
      handoffStage: null,
      provenHandleLinkId: link && head ? head.linkId : null,
      claimStatus: 'live',
      leaseDeadlineAt: args.now + args.leaseTtlMs,
      lastRenewedAt: args.now,
      handoffOperationId: null
    },
    updatedAt: args.now
  }
}

/** Renew only while the host loop can reprove child identity or still holds it without observed exit. */
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

/** Only acquisition and proven eviction may move the fence. */
export function evictAgentSessionOwner(args: {
  record: AgentSessionRecord
  expectedFence: number
  probe: AgentSessionOwnerProbe
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  const adjudication = adjudicateAgentSessionRestart({
    lease: record.lease,
    probe: args.probe,
    observedAt: args.now
  })
  if (adjudication.disposition === 'free') {
    // No outstanding owner: clear recovery stage without granting a generation or altering death evidence.
    return withLease(record, {
      ...record.lease,
      handoffStage: null,
      handoffOperationId: null,
      lastRenewedAt: args.now
    })
  }
  if (adjudication.disposition !== 'evicted') {
    throw new Error('agent_session_ownership_unknown')
  }
  return releasedAgentSessionLease(record, adjudication.nextFence, adjudication.evidence, args.now)
}

/** Release recovery when identity/stop remains unproven and the dead runtime's transport cannot drive the session.
 * This grants no death evidence: nothing proved the old process gone. */
export function releaseUnprovenAgentSessionOwner(args: {
  record: AgentSessionRecord
  expectedFence: number
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (record.lease.handoffStage !== 'recovering') {
    throw new Error('agent_session_ownership_unknown')
  }
  return releasedAgentSessionLease(record, nextAgentSessionFence(record.lease), null, args.now)
}

function releasedAgentSessionLease(
  record: AgentSessionRecord,
  runtimeFence: number,
  deathEvidence: AgentSessionDeathEvidence | null,
  now: number
): AgentSessionRecord {
  return withLease(record, {
    ...record.lease,
    runtimeFence,
    handoffStage: null,
    ownerProcess: null,
    reservedSpawnToken: null,
    claimStatus: 'released',
    lastRenewedAt: now,
    handoffOperationId: null,
    deathEvidence
  })
}
