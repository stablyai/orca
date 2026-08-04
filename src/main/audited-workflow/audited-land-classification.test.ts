// The crash-window table (Phase 10), proved against the classifier directly.
//
// THE RULE THIS FILE PINS: the ref update is the durable boundary. Once the
// source branch carries the intended sha, the land HAPPENED — the only remaining
// question is whether the index/worktree followed, which selects an ADVISORY,
// never a failure. A tip still at base is a provable no-effect regardless of how
// far the attempt believed it had progressed.
import { describe, expect, it } from 'vitest'
import { classifyLandEvidence } from './audited-land-classification'
import type { LandAttemptRow } from './audited-land-attempt-repository'
import type { LandEvidence } from './audited-land-evidence'

const BASE = 'b'.repeat(40)
const TARGET = 'c'.repeat(40)
const FOREIGN = 'f'.repeat(40)

function attempt(overrides: Partial<LandAttemptRow> = {}): LandAttemptRow {
  return {
    id: 'latt_1',
    taskId: 'task1',
    commitAttemptId: 'catt_1',
    publishAttemptId: 'patt_1',
    intendedSha: TARGET,
    intendedBranch: 'main',
    intendedBaseSha: BASE,
    sourceRepoPath: '/repo',
    sourceRepoCommonDir: '/repo/.git',
    status: 'authorized',
    reasonCode: null,
    refUpdateStarted: false,
    refUpdateCompleted: false,
    worktreeUpdateStarted: false,
    worktreeUpdateCompleted: false,
    landedSha: null,
    landingAdvisory: null,
    authorizedAt: 1,
    finalizedAt: null,
    ...overrides
  }
}

function evidence(overrides: Partial<LandEvidence> = {}): LandEvidence {
  return {
    repoIdentityIntact: true,
    branchTip: BASE,
    headCommit: false,
    committedMissingFromTip: null,
    worktreeClean: true,
    unreadable: false,
    ...overrides
  }
}

describe('before L2 — the ref provably never moved', () => {
  it('classifies a tip at base as no_effect when nothing started', () => {
    const verdict = classifyLandEvidence(attempt(), evidence())
    expect(verdict).toEqual({ kind: 'no_effect' })
  })

  it('classifies a tip at base as no_effect even mid-L2 — the CAS is atomic', () => {
    const verdict = classifyLandEvidence(
      attempt({ refUpdateStarted: true, refUpdateCompleted: false }),
      evidence({ branchTip: BASE })
    )
    expect(verdict).toEqual({ kind: 'no_effect' })
  })
})

describe('after L2 — the land is DURABLE, and the advisory records the rest', () => {
  it('classifies tip+HEAD+clean as an exact completion with NO advisory', () => {
    const verdict = classifyLandEvidence(
      attempt({ refUpdateStarted: true, refUpdateCompleted: true, worktreeUpdateCompleted: true }),
      evidence({ branchTip: TARGET, headCommit: true, worktreeClean: true })
    )
    expect(verdict).toEqual({ kind: 'exact_completion', landedSha: TARGET, advisory: null })
  })

  it('adopts a moved ref whose index never followed, with a worktree advisory', () => {
    const verdict = classifyLandEvidence(
      attempt({ refUpdateStarted: true, refUpdateCompleted: true }),
      evidence({ branchTip: TARGET, headCommit: false, worktreeClean: true })
    )
    expect(verdict).toEqual({
      kind: 'ref_moved',
      landedSha: TARGET,
      advisory: 'worktree_update_failed'
    })
  })

  it('adopts a moved ref with a DIRTY tree as a partial worktree update', () => {
    const verdict = classifyLandEvidence(
      attempt({ refUpdateStarted: true, worktreeUpdateStarted: true }),
      evidence({ branchTip: TARGET, headCommit: true, worktreeClean: false })
    )
    expect(verdict).toEqual({
      kind: 'ref_moved_worktree_partial',
      landedSha: TARGET,
      advisory: 'worktree_update_failed'
    })
  })

  it('NEVER reports a moved ref as a failure, whatever the markers say', () => {
    // Even a crash so early that no marker was written is durable if the tip moved.
    const verdict = classifyLandEvidence(
      attempt({ refUpdateStarted: false }),
      evidence({ branchTip: TARGET, headCommit: true, worktreeClean: true })
    )
    expect(verdict.kind).toBe('exact_completion')
  })
})

describe('ambiguity — anything unexplained stays guarded', () => {
  it('is ambiguous when the repository identity changed', () => {
    const verdict = classifyLandEvidence(
      attempt(),
      evidence({ repoIdentityIntact: false, branchTip: TARGET })
    )
    expect(verdict).toEqual({ kind: 'ambiguous' })
  })

  it('is ambiguous when the tip is unreadable', () => {
    const verdict = classifyLandEvidence(attempt(), evidence({ branchTip: null, unreadable: true }))
    expect(verdict).toEqual({ kind: 'ambiguous' })
  })

  it('is ambiguous when the tip is a commit we never wrote', () => {
    const verdict = classifyLandEvidence(attempt(), evidence({ branchTip: FOREIGN }))
    expect(verdict).toEqual({ kind: 'ambiguous' })
  })

  it('does NOT adopt under a sha this attempt was not authorized to produce', () => {
    // Even if our commit is reachable from the tip, the tip is not what we
    // authorized — so it stays guarded rather than being claimed as our land.
    const verdict = classifyLandEvidence(
      attempt(),
      evidence({ branchTip: FOREIGN, committedMissingFromTip: 0 })
    )
    expect(verdict).toEqual({ kind: 'ambiguous' })
  })
})
