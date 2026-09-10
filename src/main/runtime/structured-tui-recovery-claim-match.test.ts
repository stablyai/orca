import { describe, expect, it } from 'vitest'
import {
  evaluateStructuredTuiRecoveryClaim,
  type StructuredTuiRecoveryClaimCandidate
} from './structured-tui-recovery-claim-match'

// Modeled after a packaged restart whose first recovery claim failed.
const PACKAGED_CANDIDATE: StructuredTuiRecoveryClaimCandidate = {
  expectedWorkspaceId:
    '4d68c30a-b7eb-4078-a1ca-e44e9fa75024::/Users/alice/orca/workspaces/orca/recovery-fixture',
  claimMatches: true,
  pty: {
    connected: true,
    ptyId:
      '4d68c30a-b7eb-4078-a1ca-e44e9fa75024::/Users/alice/orca/workspaces/orca/recovery-fixture@@fda34510',
    incarnationId: '4cf23679-8987-487d-a24c-dba3bed1b442',
    worktreeId:
      '4d68c30a-b7eb-4078-a1ca-e44e9fa75024::/Users/alice/orca/workspaces/orca/recovery-fixture'
  },
  owner: {
    phase: 'live',
    ptyId:
      '4d68c30a-b7eb-4078-a1ca-e44e9fa75024::/Users/alice/orca/workspaces/orca/recovery-fixture@@fda34510',
    surface: {
      worktreeId:
        '4d68c30a-b7eb-4078-a1ca-e44e9fa75024::/Users/alice/orca/workspaces/orca/recovery-fixture',
      tabId: 'ced3bd39-262b-41f3-a446-92ceab4f938c',
      leafId: 'd4e9d94d-8ec3-4d0d-8ca3-52730ba61c24'
    }
  },
  persisted: {
    sessionResolved: true,
    tabPresent: true,
    ptyId:
      '4d68c30a-b7eb-4078-a1ca-e44e9fa75024::/Users/alice/orca/workspaces/orca/recovery-fixture@@fda34510',
    incarnationId: null
  }
}

type CandidatePatch = Partial<
  Omit<StructuredTuiRecoveryClaimCandidate, 'owner' | 'persisted' | 'pty'>
> & {
  owner?: Partial<Omit<StructuredTuiRecoveryClaimCandidate['owner'], 'surface'>> & {
    surface?: Partial<StructuredTuiRecoveryClaimCandidate['owner']['surface']>
  }
  persisted?: Partial<StructuredTuiRecoveryClaimCandidate['persisted']>
  pty?: Partial<StructuredTuiRecoveryClaimCandidate['pty']>
}

const MISMATCH_CASES: [string, CandidatePatch, string[]][] = [
  ['connection', { pty: { connected: false } }, ['connected']],
  ['owner phase', { owner: { phase: 'retiring' } }, ['owner-phase']],
  ['owner PTY', { owner: { ptyId: 'different-pty' } }, ['owner-pty-id', 'persisted-pty-id']],
  ['presented incarnation', { pty: { incarnationId: null } }, ['presented-incarnation']],
  ['PTY workspace', { pty: { worktreeId: 'different-workspace' } }, ['pty-workspace']],
  [
    'surface workspace',
    { owner: { surface: { worktreeId: 'different-workspace' } } },
    ['surface-workspace']
  ],
  ['claim', { claimMatches: false }, ['claim']],
  ['persisted session', { persisted: { sessionResolved: false } }, ['persisted-session']],
  ['persisted tab', { persisted: { tabPresent: false } }, ['persisted-tab']],
  ['persisted PTY', { persisted: { ptyId: 'different-pty' } }, ['persisted-pty-id']],
  [
    'persisted incarnation',
    { persisted: { incarnationId: 'different-incarnation' } },
    ['persisted-incarnation']
  ]
]

describe('structured TUI packaged recovery claim matching', () => {
  it('accepts the real first-claim surface while persisted incarnation hydration is pending', () => {
    expect(evaluateStructuredTuiRecoveryClaim(PACKAGED_CANDIDATE)).toEqual({
      matches: true,
      mismatchedFields: []
    })
  })

  it('accepts the same surface once the persisted incarnation arrives', () => {
    expect(
      evaluateStructuredTuiRecoveryClaim({
        ...PACKAGED_CANDIDATE,
        persisted: {
          ...PACKAGED_CANDIDATE.persisted,
          incarnationId: PACKAGED_CANDIDATE.pty.incarnationId
        }
      })
    ).toMatchObject({ matches: true })
  })

  it.each(MISMATCH_CASES)('rejects a %s mismatch', (_label, patch, mismatchedFields) => {
    const candidate = {
      ...PACKAGED_CANDIDATE,
      ...patch,
      pty: { ...PACKAGED_CANDIDATE.pty, ...patch.pty },
      owner: {
        ...PACKAGED_CANDIDATE.owner,
        ...patch.owner,
        surface: { ...PACKAGED_CANDIDATE.owner.surface, ...patch.owner?.surface }
      },
      persisted: { ...PACKAGED_CANDIDATE.persisted, ...patch.persisted }
    }

    expect(evaluateStructuredTuiRecoveryClaim(candidate)).toEqual({
      matches: false,
      mismatchedFields
    })
  })
})
