import type { TerminalCommandBoundary } from './terminal-command-paint'
import type { AgentPromptTurnStartEvidence } from './agent-prompt-submission-verification'

/** Attribute each PTY-wide turn to the oldest eligible queued prompt; one turn cannot settle multiple requests. */

// Stalled entries persist until PTY/generation removal; bound the backlog.
const REQUESTS_PER_PTY_LIMIT = 1_024

type AgentPromptRequestBaseline = {
  baselineWorkingSequence: number
  baselineExplicitWorkingStartedAt: number | null
}

export type AgentPromptOperation = {
  generation: number
  requestId?: string
  phase: 'provisional' | 'accepted' | 'retired'
  bindingIsCurrent?: () => boolean
  baseline?: AgentPromptRequestBaseline
  permitsStart?: (boundary: TerminalCommandBoundary) => boolean
}

type TurnStartClaim = {
  generation: number
  kind: 'hook' | 'lifecycle'
  /** Hook turn-start timestamp, or the lifecycle working sequence the turn was attributed to. */
  value: number
  operation: AgentPromptOperation
}

export class AgentPromptRequestCorrelation {
  private readonly requestsByPty = new Map<string, AgentPromptOperation[]>()
  private readonly claimsByPty = new Map<string, TurnStartClaim[]>()

  begin(
    ptyId: string,
    generation: number,
    requestId?: string,
    permitsStart?: AgentPromptOperation['permitsStart'],
    bindingIsCurrent?: () => boolean
  ): AgentPromptOperation {
    const requests = this.requestsByPty.get(ptyId) ?? []
    const retained = requests.filter((candidate) => {
      if (requestId && candidate.generation === generation && candidate.requestId === requestId) {
        this.retire(candidate)
        return false
      }
      return true
    })
    const operation: AgentPromptOperation = {
      generation,
      requestId,
      phase: 'provisional',
      permitsStart,
      bindingIsCurrent
    }
    retained.push(operation)
    while (retained.length > REQUESTS_PER_PTY_LIMIT) {
      this.retire(retained.shift()!)
    }
    this.requestsByPty.set(ptyId, retained)
    return operation
  }

  acceptBaseline(operation: AgentPromptOperation, baseline: AgentPromptRequestBaseline): boolean {
    if (operation.phase !== 'provisional' || operation.bindingIsCurrent?.() === false) {
      return false
    }
    operation.baseline = baseline
    operation.phase = 'accepted'
    return true
  }

  find(
    ptyId: string,
    generation: number,
    requestId: string,
    baseline: AgentPromptRequestBaseline
  ): AgentPromptOperation | undefined {
    return this.requestsByPty
      .get(ptyId)
      ?.find(
        (candidate) =>
          candidate.phase === 'accepted' &&
          candidate.bindingIsCurrent?.() !== false &&
          candidate.generation === generation &&
          candidate.requestId === requestId &&
          candidate.baseline?.baselineWorkingSequence === baseline.baselineWorkingSequence &&
          candidate.baseline.baselineExplicitWorkingStartedAt ===
            baseline.baselineExplicitWorkingStartedAt
      )
  }

  forget(ptyId: string, operation: AgentPromptOperation): void {
    this.retire(operation)
    const requests = this.requestsByPty.get(ptyId)
    const index = requests?.indexOf(operation) ?? -1
    if (index !== -1) {
      requests!.splice(index, 1)
    }
  }

  retireForBoundary(ptyId: string, boundary: TerminalCommandBoundary): void {
    const requests = this.requestsByPty.get(ptyId)
    if (!requests) {
      return
    }
    const retained: AgentPromptOperation[] = []
    for (const operation of requests) {
      if (boundary.kind === 'start' && operation.permitsStart?.(boundary)) {
        operation.permitsStart = undefined
        retained.push(operation)
      } else {
        this.retire(operation)
      }
    }
    if (retained.length) {
      this.requestsByPty.set(ptyId, retained)
    } else {
      this.requestsByPty.delete(ptyId)
    }
  }

  clearForPty(ptyId: string): void {
    for (const operation of this.requestsByPty.get(ptyId) ?? []) {
      this.retire(operation)
    }
    this.requestsByPty.delete(ptyId)
    this.claimsByPty.delete(ptyId)
  }

  private retire(operation: AgentPromptOperation): void {
    operation.phase = 'retired'
    operation.permitsStart = undefined
    operation.bindingIsCurrent = undefined
  }

  acceptTurnStart(
    ptyId: string,
    operation: AgentPromptOperation,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    const baseline = operation.baseline
    if (
      operation.phase !== 'accepted' ||
      operation.bindingIsCurrent?.() === false ||
      !operation.requestId ||
      !baseline ||
      !isTurnStartAfterBaseline(evidence, baseline)
    ) {
      return false
    }
    const requests = this.requestsByPty.get(ptyId) ?? []
    if (!requests.includes(operation)) {
      return false
    }
    let claim: TurnStartClaim | null
    if (evidence.kind === 'lifecycle') {
      this.allocateLifecycleClaims(ptyId, operation.generation, evidence)
      claim = this.findClaim(ptyId, operation)
    } else {
      const first = requests.find(
        (candidate) =>
          candidate.phase === 'accepted' &&
          candidate.bindingIsCurrent?.() !== false &&
          candidate.requestId &&
          candidate.baseline &&
          candidate.generation === operation.generation &&
          isTurnStartAfterBaseline(evidence, candidate.baseline)
      )
      if (first !== operation) {
        return false
      }
      claim = this.nextFreeClaim(ptyId, operation, evidence)
    }
    if (!claim) {
      return false
    }
    const owner = this.claimOwner(ptyId, claim)
    if (owner && owner !== operation) {
      return false
    }
    this.recordClaim(ptyId, claim)
    this.forget(ptyId, operation)
    return true
  }

  private allocateLifecycleClaims(
    ptyId: string,
    generation: number,
    evidence: Extract<AgentPromptTurnStartEvidence, { kind: 'lifecycle' }>
  ): void {
    for (const candidate of this.requestsByPty.get(ptyId) ?? []) {
      if (
        candidate.phase !== 'accepted' ||
        candidate.bindingIsCurrent?.() === false ||
        !candidate.requestId ||
        !candidate.baseline ||
        candidate.generation !== generation ||
        !isTurnStartAfterBaseline(evidence, candidate.baseline) ||
        this.findClaim(ptyId, candidate)
      ) {
        continue
      }
      // A later baseline may have no free sequence while an earlier one still can claim; keep scanning.
      const claim = this.nextFreeClaim(ptyId, candidate, evidence)
      if (claim) {
        this.recordClaim(ptyId, claim)
      }
    }
  }

  private findClaim(ptyId: string, operation: AgentPromptOperation): TurnStartClaim | null {
    return this.claimsByPty.get(ptyId)?.find((claim) => claim.operation === operation) ?? null
  }

  private claimOwner(ptyId: string, claim: TurnStartClaim): AgentPromptOperation | null {
    return (
      this.claimsByPty
        .get(ptyId)
        ?.find(
          (existing) =>
            existing.generation === claim.generation &&
            existing.kind === claim.kind &&
            existing.value === claim.value
        )?.operation ?? null
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
    operation: AgentPromptOperation,
    evidence: AgentPromptTurnStartEvidence
  ): TurnStartClaim | null {
    const generation = operation.generation
    if (evidence.kind === 'hook') {
      return { generation, kind: 'hook', value: evidence.workingStartedAt, operation }
    }
    const claimed = new Set(
      (this.claimsByPty.get(ptyId) ?? [])
        .filter((claim) => claim.generation === generation && claim.kind === 'lifecycle')
        .map((claim) => claim.value)
    )
    let sequence = operation.baseline!.baselineWorkingSequence + 1
    while (claimed.has(sequence)) {
      sequence += 1
    }
    return sequence <= evidence.workingSequence
      ? { generation, kind: 'lifecycle', value: sequence, operation }
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
