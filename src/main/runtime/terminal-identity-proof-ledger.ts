import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../shared/execution-host'

export const TERMINAL_IDENTITY_PROOF_TTL_MS = 30_000
export const TERMINAL_IDENTITY_PROOF_MAX_CHALLENGES = 64

export type TerminalIdentityProofCandidate = Readonly<{
  handle: string
  ptyId: string
  incarnationId: string
  tabId: string
  leafId: string
  generation: number
  cursor: number
}>

export type TerminalIdentityProofChallenge = Readonly<{
  challengeId: string
  marker: string
  runtimeId: string
  worktreeId: string
  executionHostId: ExecutionHostId
  topologyRevision: number
  callerFingerprint?: string
  issuedAt: number
  expiresAt: number
  candidates: readonly TerminalIdentityProofCandidate[]
}>

export type TerminalIdentityProofDelta = Readonly<{
  stream: Readonly<{
    lines: readonly string[]
    truncated: boolean
    limited: boolean
  }>
  screen: Readonly<{
    lines: readonly string[]
  }>
}>

export class TerminalIdentityProofLedger {
  private readonly challenges = new Map<string, TerminalIdentityProofChallenge>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxChallenges = TERMINAL_IDENTITY_PROOF_MAX_CHALLENGES
  ) {}

  issue(input: {
    runtimeId: string
    worktreeId: string
    executionHostId: ExecutionHostId
    topologyRevision: number
    callerFingerprint?: string
    candidates: readonly TerminalIdentityProofCandidate[]
  }): TerminalIdentityProofChallenge {
    const issuedAt = this.now()
    this.pruneExpired(issuedAt)
    if (this.challenges.size >= this.maxChallenges) {
      throw new Error('terminal_identity_proof_capacity')
    }
    const challengeId = randomUUID()
    const challenge = Object.freeze({
      ...input,
      candidates: Object.freeze(
        input.candidates.map((candidate) => Object.freeze({ ...candidate }))
      ),
      challengeId,
      marker: `ORCA_TERMINAL_IDENTITY_PROOF_V1:${randomUUID()}`,
      issuedAt,
      expiresAt: issuedAt + TERMINAL_IDENTITY_PROOF_TTL_MS
    })
    this.challenges.set(challengeId, challenge)
    return challenge
  }

  claim(challengeId: string): TerminalIdentityProofChallenge {
    const challenge = this.challenges.get(challengeId)
    if (!challenge) {
      throw new Error('terminal_identity_challenge_not_found')
    }
    this.challenges.delete(challengeId)
    if (challenge.expiresAt <= this.now()) {
      throw new Error('terminal_identity_proof_expired')
    }
    return challenge
  }

  private pruneExpired(now: number): void {
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) {
        this.challenges.delete(challengeId)
      }
    }
  }
}

export function resolveTerminalIdentityProofMatch(
  challenge: TerminalIdentityProofChallenge,
  deltas: ReadonlyMap<string, TerminalIdentityProofDelta>
): TerminalIdentityProofCandidate {
  let matched: TerminalIdentityProofCandidate | null = null
  let occurrences = 0
  for (const candidate of challenge.candidates) {
    const delta = deltas.get(candidate.ptyId)
    if (!delta || delta.stream.truncated || delta.stream.limited) {
      throw new Error('terminal_identity_proof_unverifiable')
    }
    const streamOccurrences = countLineOccurrences(delta.stream.lines, challenge.marker)
    // Visible snapshots are terminal rows, so a narrow pane may split one marker across rows.
    const screenOccurrences = countOccurrences(delta.screen.lines.join(''), challenge.marker)
    const candidateOccurrences = Math.max(streamOccurrences, screenOccurrences)
    if (candidateOccurrences > 0) {
      matched = candidate
      occurrences += candidateOccurrences
    }
  }
  if (occurrences === 0 || !matched) {
    throw new Error('terminal_identity_proof_not_found')
  }
  if (occurrences !== 1) {
    throw new Error('terminal_identity_proof_ambiguous')
  }
  return matched
}

function countLineOccurrences(lines: readonly string[], marker: string): number {
  return lines.reduce((count, line) => count + countOccurrences(line, marker), 0)
}

function countOccurrences(value: string, marker: string): number {
  let count = 0
  let index = 0
  while ((index = value.indexOf(marker, index)) !== -1) {
    count += 1
    index += marker.length
  }
  return count
}
