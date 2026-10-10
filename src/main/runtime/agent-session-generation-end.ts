// Which agent generations a committed store transaction ended: every lease write that revokes or
// supersedes a generation that could still act. A release of any kind (exit, surface, failed
// acquisition, eviction, unproven, restart adjudication) moves the fence and leaves no owner; a
// reservation granted over an owner a probe proved gone supersedes it directly. Reserving a lease
// already released ends nothing new: that generation was told at its release.

import {
  agentSessionDeathEvidenceFromProbe,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionDeathEvidence,
  AgentSessionLease,
  AgentSessionRecord
} from '../../shared/agent-session-record'

export type AgentSessionGenerationEnd = {
  sessionId: string
  /** The generation that can no longer act. */
  endedFence: number
  /** The proof of how it ended: the release's own, or, for a reservation that replaced it, the
   *  probe's, which the reservation clears from the lease. Null when nothing proved it gone. */
  evidence: AgentSessionDeathEvidence | null
}

/** A transaction's own proof for a generation its reservation superseded. */
export type AgentSessionSupersessionEvidence = (
  ended: AgentSessionLease
) => AgentSessionDeathEvidence | null

/** What a store transaction may say of the generations it ends. */
export type AgentSessionGenerationEndOptions = {
  supersessionEvidence?: AgentSessionSupersessionEvidence
}

/** A reservation granted over an owner the probe proved gone ends it with that probe's proof, which
 *  the reservation clears from the lease. */
export function reservationSupersessionEvidence(
  probe: AgentSessionOwnerProbe,
  now: number
): AgentSessionSupersessionEvidence {
  return (ended) => agentSessionDeathEvidenceFromProbe(probe, now, ended)
}

export function agentSessionLeasesBefore(
  records: ReadonlyMap<string, AgentSessionRecord>
): Map<string, AgentSessionLease> {
  return new Map([...records].map(([sessionId, record]) => [sessionId, record.lease]))
}

export function agentSessionGenerationEnds(
  before: ReadonlyMap<string, AgentSessionLease>,
  after: ReadonlyMap<string, AgentSessionRecord>,
  supersessionEvidence?: AgentSessionSupersessionEvidence
): AgentSessionGenerationEnd[] {
  const ends: AgentSessionGenerationEnd[] = []
  for (const [sessionId, { lease }] of after) {
    const prior = before.get(sessionId)
    if (!prior || prior === lease) {
      continue
    }
    // A released lease's generation ended at its release; acquiring it again ends nothing.
    if (prior.claimStatus === 'released') {
      continue
    }
    const released = lease.claimStatus === 'released'
    if (!released && lease.runtimeFence === prior.runtimeFence) {
      continue
    }
    ends.push({
      sessionId,
      endedFence: prior.runtimeFence,
      evidence: released ? lease.deathEvidence : (supersessionEvidence?.(prior) ?? null)
    })
  }
  return ends
}
