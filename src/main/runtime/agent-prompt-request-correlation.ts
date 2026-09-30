import type { AgentPromptTurnStartEvidence } from './agent-prompt-submission-verification'

/**
 * Per-PTY ledger that decides which queued prompt owns an observed turn start.
 *
 * Turn evidence is PTY-wide, so without an owner one observed turn would settle every queued
 * prompt that shares its baseline. Registrations stay in arrival order per PTY: the oldest
 * eligible request claims the next turn, and a claimed turn can never change hands.
 */

// A stalled request is only dropped when its PTY or generation goes away, so cap the backlog.
const REQUESTS_PER_PTY_LIMIT = 1_024

export type AgentPromptRequestBaseline = {
  generation: number
  requestId: string
  baselineWorkingSequence: number
  baselineExplicitWorkingStartedAt: number | null
}

type TurnStartClaim = {
  generation: number
  kind: 'hook' | 'lifecycle'
  /** Hook turn-start timestamp, or the lifecycle working sequence the turn was attributed to. */
  value: number
  requestId: string
}

export class AgentPromptRequestCorrelation {
  private readonly requestsByPty = new Map<string, AgentPromptRequestBaseline[]>()
  private readonly claimsByPty = new Map<string, TurnStartClaim[]>()

  register(ptyId: string, request: AgentPromptRequestBaseline): void {
    const requests = this.requestsByPty.get(ptyId) ?? []
    const existing = requests.findIndex(
      (candidate) =>
        candidate.generation === request.generation && candidate.requestId === request.requestId
    )
    if (existing !== -1) {
      requests.splice(existing, 1)
    }
    requests.push(request)
    if (requests.length > REQUESTS_PER_PTY_LIMIT) {
      requests.splice(0, requests.length - REQUESTS_PER_PTY_LIMIT)
    }
    this.requestsByPty.set(ptyId, requests)
  }

  forget(ptyId: string, generation: number, requestId: string): void {
    const requests = this.requestsByPty.get(ptyId)
    const index = requests?.findIndex(
      (candidate) => candidate.generation === generation && candidate.requestId === requestId
    )
    if (requests && index !== undefined && index !== -1) {
      requests.splice(index, 1)
    }
  }

  clearForPty(ptyId: string): void {
    this.requestsByPty.delete(ptyId)
    this.claimsByPty.delete(ptyId)
  }

  acceptTurnStart(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    if (
      !isTurnStartAfterBaseline(evidence, {
        baselineWorkingSequence,
        baselineExplicitWorkingStartedAt
      })
    ) {
      return false
    }
    const requests = this.requestsByPty.get(ptyId) ?? []
    const request = requests.find(
      (candidate) => candidate.generation === generation && candidate.requestId === requestId
    )
    // A receipt restored after a runtime restart has no in-memory registration;
    // leave it queued rather than attributing an unrelated turn to it.
    if (
      !request ||
      request.baselineWorkingSequence !== baselineWorkingSequence ||
      request.baselineExplicitWorkingStartedAt !== baselineExplicitWorkingStartedAt
    ) {
      return false
    }
    let claim: TurnStartClaim | null
    if (evidence.kind === 'lifecycle') {
      this.allocateLifecycleClaims(ptyId, generation, evidence)
      claim = this.findClaim(ptyId, generation, requestId)
    } else {
      const first = requests.find(
        (candidate) =>
          candidate.generation === generation && isTurnStartAfterBaseline(evidence, candidate)
      )
      if (first && first.requestId !== requestId) {
        return false
      }
      claim = this.nextFreeClaim(ptyId, generation, baselineWorkingSequence, evidence, requestId)
    }
    if (!claim) {
      return false
    }
    const owner = this.claimOwner(ptyId, claim)
    if (owner && owner !== requestId) {
      return false
    }
    this.recordClaim(ptyId, claim)
    this.forget(ptyId, generation, requestId)
    return true
  }

  private allocateLifecycleClaims(
    ptyId: string,
    generation: number,
    evidence: Extract<AgentPromptTurnStartEvidence, { kind: 'lifecycle' }>
  ): void {
    for (const candidate of this.requestsByPty.get(ptyId) ?? []) {
      if (
        candidate.generation !== generation ||
        !isTurnStartAfterBaseline(evidence, candidate) ||
        this.findClaim(ptyId, generation, candidate.requestId)
      ) {
        continue
      }
      // A candidate with a later baseline can run out of free sequences while an
      // earlier-baselined one still has room, so keep scanning the queue.
      const claim = this.nextFreeClaim(
        ptyId,
        generation,
        candidate.baselineWorkingSequence,
        evidence,
        candidate.requestId
      )
      if (claim) {
        this.recordClaim(ptyId, claim)
      }
    }
  }

  private findClaim(ptyId: string, generation: number, requestId: string): TurnStartClaim | null {
    return (
      this.claimsByPty
        .get(ptyId)
        ?.find((claim) => claim.generation === generation && claim.requestId === requestId) ?? null
    )
  }

  private claimOwner(ptyId: string, claim: TurnStartClaim): string | null {
    return (
      this.claimsByPty
        .get(ptyId)
        ?.find(
          (existing) =>
            existing.generation === claim.generation &&
            existing.kind === claim.kind &&
            existing.value === claim.value
        )?.requestId ?? null
    )
  }

  private recordClaim(ptyId: string, claim: TurnStartClaim): void {
    const claims = this.claimsByPty.get(ptyId) ?? []
    const existing = claims.findIndex(
      (candidate) =>
        candidate.generation === claim.generation &&
        candidate.kind === claim.kind &&
        candidate.value === claim.value
    )
    if (existing === -1) {
      claims.push(claim)
      if (claims.length > REQUESTS_PER_PTY_LIMIT) {
        claims.splice(0, claims.length - REQUESTS_PER_PTY_LIMIT)
      }
    } else {
      claims[existing] = claim
    }
    this.claimsByPty.set(ptyId, claims)
  }

  private nextFreeClaim(
    ptyId: string,
    generation: number,
    baselineWorkingSequence: number,
    evidence: AgentPromptTurnStartEvidence,
    requestId: string
  ): TurnStartClaim | null {
    if (evidence.kind === 'hook') {
      return { generation, kind: 'hook', value: evidence.workingStartedAt, requestId }
    }
    const claimed = new Set(
      (this.claimsByPty.get(ptyId) ?? [])
        .filter((claim) => claim.generation === generation && claim.kind === 'lifecycle')
        .map((claim) => claim.value)
    )
    let sequence = baselineWorkingSequence + 1
    while (claimed.has(sequence)) {
      sequence += 1
    }
    return sequence <= evidence.workingSequence
      ? { generation, kind: 'lifecycle', value: sequence, requestId }
      : null
  }
}

function isTurnStartAfterBaseline(
  evidence: AgentPromptTurnStartEvidence,
  baseline: { baselineWorkingSequence: number; baselineExplicitWorkingStartedAt: number | null }
): boolean {
  return evidence.kind === 'lifecycle'
    ? evidence.workingSequence > baseline.baselineWorkingSequence
    : evidence.workingStartedAt > (baseline.baselineExplicitWorkingStartedAt ?? 0)
}
