// What this host knows in memory about a session's owner: the child it runs, the exit of that child
// it watched, how its own failed attempt accounted for its process, and whether an acquisition of
// its own is under way.
//
// Only an owner this host recorded at the lease's current fence is spoken for. A fence is granted by
// exactly one acquisition, and this host's store is the only writer, so a child, an ended child or a
// failed attempt at that fence IS the lease's owner. An owner on any other host gets nothing from
// memory: only a probe may speak for it, and it answers `indeterminate`.

import {
  failedAcquisitionReleasesReservation,
  isFailedAcquisitionReservation
} from '../../../shared/agent-session-failed-acquisition'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  agentSessionLeaseFreeEvidence,
  deriveAgentSessionLeaseState,
  type AgentSessionHostProof
} from '../../../shared/agent-session-lease-state'
import type {
  AgentSessionDeathEvidence,
  AgentSessionLease,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionFailedAcquisitionSettlement } from '../../runtime/agent-session-acquisition-failure-settlement'
import { MAX_UNEXPECTED_EXIT_REASON_CHARS } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export function structuredAgentSessionOwnerProof(input: {
  lease: AgentSessionLease
  hostId: string
  session: Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'> | undefined
  attemptInFlight: boolean
  /** This host's last failed attempt for the session whose settlement write did not land. */
  unsettledAcquisition?: AgentSessionFailedAcquisitionSettlement
}): AgentSessionHostProof {
  const { lease, session } = input
  const fence = lease.runtimeFence
  const proof = { fence, attemptInFlight: input.attemptInFlight }
  const failed = input.unsettledAcquisition
  if (
    failed?.fence === fence &&
    isFailedAcquisitionReservation(lease, failed) &&
    // A reservation names no host: its own token at its own fence is what makes it this host's.
    (lease.ownerProcess === null ||
      (lease.ownerProcess.hostId === input.hostId &&
        lease.ownerProcess.spawnToken === failed.spawnToken))
  ) {
    return {
      ...proof,
      owner: {
        kind: 'failed-acquisition',
        spawnToken: failed.spawnToken,
        operationId: failed.operationId,
        exitProof: failed.exitProof,
        observedAt: failed.now
      }
    }
  }
  if (lease.ownerProcess?.hostId !== input.hostId) {
    return { ...proof, owner: { kind: 'none' } }
  }
  if (session?.child?.fence === fence) {
    return { ...proof, owner: { kind: 'runs' } }
  }
  const ended = session?.lastEndedChild
  if (!session?.child && ended?.fence === fence && ended.rootGone) {
    return {
      ...proof,
      owner: {
        kind: 'watched-exit',
        observedAt: ended.observedAt,
        // A stop's release says only that the surface let go; an exit carries the provider's reason.
        reason:
          ended.cause === 'exit' && ended.reason
            ? ended.reason.slice(0, MAX_UNEXPECTED_EXIT_REASON_CHARS)
            : null
      }
    }
  }
  return { ...proof, owner: { kind: 'none' } }
}

/** The probe an acquisition's compare-and-swap reads. A watched exit is `exit-observed`, the
 *  vocabulary's own word for it; this host's child echoed the reserved token when its identity was
 *  committed. No record means nothing was ever reserved. A failed attempt speaks only where its
 *  settlement releases the reservation: its recorded owner exited, or nothing runs under it. One
 *  its settlement would park in recovery proves nothing, so the swap refuses as it would there. */
export function structuredAgentSessionAcquisitionProbe(
  lease: AgentSessionLease | null,
  proof: AgentSessionHostProof | null
): AgentSessionOwnerProbe {
  switch (proof?.owner.kind) {
    case undefined:
      return { outcome: 'reservation-unused' }
    case 'watched-exit':
      return { outcome: 'exit-observed' }
    case 'failed-acquisition':
      if (!lease || !failedAcquisitionReleasesReservation(lease, proof.owner.exitProof)) {
        return { outcome: 'indeterminate', reason: 'a failed start could not prove its owner gone' }
      }
      return lease.ownerProcess ? { outcome: 'exit-observed' } : { outcome: 'reservation-unused' }
    case 'probed':
      return proof.owner.probe
    case 'runs':
      return { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
    case 'none':
      return { outcome: 'indeterminate', reason: 'an acquisition of this host is in flight' }
  }
}

/** How the previous generation ended, as the lease derives it: a release that never landed still
 *  settles what that generation left running from the proof that would have written it. */
export function structuredAgentSessionPriorDeathEvidence(
  record: AgentSessionRecord | null,
  proof: AgentSessionHostProof | null,
  now: number
): AgentSessionDeathEvidence | null {
  if (!record) {
    return null
  }
  const state = deriveAgentSessionLeaseState(record.lease, proof)
  return state.state === 'free'
    ? agentSessionLeaseFreeEvidence(record.lease, state.basis, now)
    : record.lease.deathEvidence
}
