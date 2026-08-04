// Phase 8 §6 — crash classification.
//
// The doctrine under test: adoption requires EVERY channel to match, and anything
// partial is ambiguous. The one deliberate relaxation is that
// partial_promotion/orphan_commit are no-effect rather than ambiguous, which is
// sound ONLY because the phase ordering proves the ref never moved.
import { describe, expect, it } from 'vitest'
import { classifyCommitEvidence } from './audited-commit-classification'
import type { CommitAttemptRow } from './audited-commit-attempt-repository'
import type { CommitEvidence } from './audited-commit-evidence'

const TREE = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)
const COMMIT = 'c'.repeat(40)
const MSG_SHA = 'd'.repeat(64)

function attempt(overrides: Partial<CommitAttemptRow> = {}): CommitAttemptRow {
  return {
    id: 'catt_1',
    taskId: 'task1',
    approvalId: 'appr_1',
    intendedTreeOid: TREE,
    intendedParent: PARENT,
    intendedBranch: 'orca/audited/task1',
    intendedMessageSha: MSG_SHA,
    status: 'authorized',
    reasonCode: null,
    promotionStarted: false,
    promotionCompleted: false,
    verifiedTreeOid: null,
    createdCommitSha: null,
    refUpdated: false,
    indexRefreshed: false,
    postCommitAdvisory: null,
    authorizedAt: 1,
    finalizedAt: null,
    ...overrides
  }
}

function evidence(overrides: Partial<CommitEvidence> = {}): CommitEvidence {
  return {
    treePresent: false,
    commitPresent: false,
    branchTip: PARENT,
    commitTree: null,
    commitParent: null,
    commitMessageSha: null,
    descendantCount: null,
    ...overrides
  }
}

describe('commit evidence classification', () => {
  it('classifies a pre-promotion crash as no_effect', () => {
    expect(classifyCommitEvidence(attempt(), evidence()).kind).toBe('no_effect')
  })

  it('classifies a crash during promotion as partial_promotion', () => {
    const result = classifyCommitEvidence(
      attempt({ promotionStarted: true }),
      evidence({ treePresent: true })
    )
    expect(result.kind).toBe('partial_promotion')
  })

  it('classifies a crash between commit-tree and update-ref as orphan_commit', () => {
    const result = classifyCommitEvidence(
      attempt({ promotionStarted: true, createdCommitSha: COMMIT }),
      evidence({ treePresent: true, commitPresent: true, branchTip: PARENT })
    )
    expect(result.kind).toBe('orphan_commit')
  })

  it('adopts an exact completion idempotently', () => {
    const result = classifyCommitEvidence(
      attempt({ promotionStarted: true, createdCommitSha: COMMIT }),
      evidence({
        treePresent: true,
        commitPresent: true,
        branchTip: COMMIT,
        commitTree: TREE,
        commitParent: PARENT,
        commitMessageSha: MSG_SHA,
        descendantCount: 1
      })
    )
    expect(result.kind).toBe('exact_completion')
    if (result.kind === 'exact_completion') {
      expect(result.commitSha).toBe(COMMIT)
    }
  })

  // Every partial mismatch on the adopted path must be ambiguous, not adopted.
  it.each([
    ['a different tree', { commitTree: 'e'.repeat(40) }],
    ['a different parent', { commitParent: 'f'.repeat(40) }],
    ['a different message', { commitMessageSha: '0'.repeat(64) }],
    ['a non-descendant', { descendantCount: 0 }],
    ['a missing object', { commitPresent: false }]
  ])('refuses to adopt when the ref moved but %s', (_label, overrides) => {
    const result = classifyCommitEvidence(
      attempt({ promotionStarted: true, createdCommitSha: COMMIT }),
      evidence({
        treePresent: true,
        commitPresent: true,
        branchTip: COMMIT,
        commitTree: TREE,
        commitParent: PARENT,
        commitMessageSha: MSG_SHA,
        descendantCount: 1,
        ...overrides
      })
    )
    expect(result.kind).toBe('ambiguous')
  })

  it('is ambiguous when the branch moved somewhere unexplained', () => {
    const result = classifyCommitEvidence(
      attempt({ promotionStarted: true, createdCommitSha: COMMIT }),
      evidence({ commitPresent: true, branchTip: 'f'.repeat(40) })
    )
    expect(result.kind).toBe('ambiguous')
  })

  it('is ambiguous when the branch is unreadable', () => {
    const result = classifyCommitEvidence(
      attempt({ promotionStarted: true }),
      evidence({ branchTip: null })
    )
    expect(result.kind).toBe('ambiguous')
  })
})
