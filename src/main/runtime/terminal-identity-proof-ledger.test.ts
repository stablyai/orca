import { describe, expect, it } from 'vitest'
import {
  resolveTerminalIdentityProofMatch,
  TerminalIdentityProofLedger,
  TERMINAL_IDENTITY_PROOF_TTL_MS,
  type TerminalIdentityProofCandidate
} from './terminal-identity-proof-ledger'

const candidate = (ptyId: string): TerminalIdentityProofCandidate => ({
  handle: `term_${ptyId}`,
  ptyId,
  incarnationId: `inc_${ptyId}`,
  tabId: `tab_${ptyId}`,
  leafId: `leaf_${ptyId}`,
  generation: 1,
  cursor: 4
})

const delta = (
  streamLines: string[],
  screenLines: string[] = [],
  streamFlags: { truncated?: boolean; limited?: boolean } = {}
) => ({
  stream: {
    lines: streamLines,
    truncated: streamFlags.truncated ?? false,
    limited: streamFlags.limited ?? false
  },
  screen: { lines: screenLines }
})

function issue(ledger: TerminalIdentityProofLedger) {
  return ledger.issue({
    runtimeId: 'runtime-1',
    worktreeId: 'repo::/worktree',
    executionHostId: 'local',
    topologyRevision: 2,
    candidates: [candidate('a'), candidate('b')]
  })
}

describe('TerminalIdentityProofLedger', () => {
  it('issues a single-use runtime-scoped challenge', () => {
    const ledger = new TerminalIdentityProofLedger(() => 100)
    const challenge = issue(ledger)

    expect(challenge.marker).toMatch(/^ORCA_TERMINAL_IDENTITY_PROOF_V1:/)
    expect(ledger.claim(challenge.challengeId)).toBe(challenge)
    expect(() => ledger.claim(challenge.challengeId)).toThrow(
      'terminal_identity_challenge_not_found'
    )
  })

  it('expires and bounds outstanding challenges', () => {
    let now = 100
    const ledger = new TerminalIdentityProofLedger(() => now, 1)
    const challenge = issue(ledger)
    expect(() => issue(ledger)).toThrow('terminal_identity_proof_capacity')

    now += TERMINAL_IDENTITY_PROOF_TTL_MS
    expect(() => ledger.claim(challenge.challengeId)).toThrow('terminal_identity_proof_expired')
    expect(issue(ledger)).toBeDefined()
  })
})

describe('resolveTerminalIdentityProofMatch', () => {
  it('returns the sole candidate containing the post-cursor marker', () => {
    const challenge = issue(new TerminalIdentityProofLedger(() => 100))
    const match = resolveTerminalIdentityProofMatch(
      challenge,
      new Map([
        ['a', delta(['ordinary output'])],
        ['b', delta([`tool result ${challenge.marker}`])]
      ])
    )

    expect(match.ptyId).toBe('b')
  })

  it.each([
    ['missing', ['ordinary output'], 'terminal_identity_proof_not_found'],
    [
      'duplicated',
      ['ORCA_TERMINAL_IDENTITY_PROOF_V1:placeholder'],
      'terminal_identity_proof_not_found'
    ]
  ])('fails closed when the marker is %s', (_name, lines, error) => {
    const challenge = issue(new TerminalIdentityProofLedger(() => 100))
    expect(() =>
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta(lines)],
          ['b', delta([])]
        ])
      )
    ).toThrow(error)
  })

  it('rejects duplicate markers and incomplete transcript ranges', () => {
    const challenge = issue(new TerminalIdentityProofLedger(() => 100))
    expect(() =>
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([challenge.marker])],
          ['b', delta([challenge.marker])]
        ])
      )
    ).toThrow('terminal_identity_proof_ambiguous')
    expect(() =>
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([challenge.marker])],
          ['b', delta([], [], { truncated: true })]
        ])
      )
    ).toThrow('terminal_identity_proof_unverifiable')
  })

  it('accepts a marker visible only on screen and de-duplicates one marker across projections', () => {
    const challenge = issue(new TerminalIdentityProofLedger(() => 100))
    expect(
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([], [challenge.marker])],
          ['b', delta([])]
        ])
      ).ptyId
    ).toBe('a')
    expect(
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([challenge.marker], [challenge.marker])],
          ['b', delta([])]
        ])
      ).ptyId
    ).toBe('a')
  })

  it('reconstructs a marker wrapped across visible terminal rows', () => {
    const challenge = issue(new TerminalIdentityProofLedger(() => 100))
    const splitAt = Math.floor(challenge.marker.length / 2)
    expect(
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([], [challenge.marker.slice(0, splitAt), challenge.marker.slice(splitAt)])],
          ['b', delta([])]
        ])
      ).ptyId
    ).toBe('a')
  })

  it('rejects screen matches across candidates and repeated text within one candidate', () => {
    const challenge = issue(new TerminalIdentityProofLedger(() => 100))
    expect(() =>
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([], [challenge.marker])],
          ['b', delta([], [challenge.marker])]
        ])
      )
    ).toThrow('terminal_identity_proof_ambiguous')
    expect(() =>
      resolveTerminalIdentityProofMatch(
        challenge,
        new Map([
          ['a', delta([], [`${challenge.marker} ${challenge.marker}`])],
          ['b', delta([])]
        ])
      )
    ).toThrow('terminal_identity_proof_ambiguous')
  })
})
