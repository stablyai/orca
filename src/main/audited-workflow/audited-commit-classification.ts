// Classifies commit-attempt evidence into exactly one recovery decision.
//
// Follows the worktree lane's doctrine verbatim: adoption requires EVERY channel
// to match, and anything partial is ambiguous and never remediated automatically.
//
// The one place this lane is safely LESS conservative than the worktree lane:
// writing an unreferenced object is genuinely a no-op for the user (nothing in
// their history changed, `git status` is unaffected, and gc reclaims it), whereas
// a half-created worktree is not. That is why partial_promotion and orphan_commit
// are no-effect rather than ambiguous — and it is sound only because the phase
// ordering guarantees the ref never moved in either case.
import type { CommitAttemptRow } from './audited-commit-attempt-repository'
import type { CommitEvidence } from './audited-commit-evidence'

export type CommitClassification =
  /** Nothing was written and no ref moved: safe to retry. */
  | { kind: 'no_effect' }
  /** Objects may exist but no commit was created; the ref never moved. */
  | { kind: 'partial_promotion' }
  /** The commit object exists but the ref never moved: inert, gc-able. */
  | { kind: 'orphan_commit' }
  /** Every channel matches the claim exactly: adopt idempotently. */
  | { kind: 'exact_completion'; commitSha: string }
  /** Anything else: block, touch nothing, never auto-remediate. */
  | { kind: 'ambiguous' }

export function classifyCommitEvidence(
  attempt: CommitAttemptRow,
  evidence: CommitEvidence
): CommitClassification {
  const sha = attempt.createdCommitSha

  // The ref moved to exactly the commit we recorded — the only adoptable shape.
  if (sha !== null && evidence.branchTip === sha) {
    const exact =
      evidence.commitPresent &&
      evidence.commitTree === attempt.intendedTreeOid &&
      evidence.commitParent === attempt.intendedParent &&
      evidence.commitMessageSha === attempt.intendedMessageSha &&
      evidence.descendantCount === 1
    return exact ? { kind: 'exact_completion', commitSha: sha } : { kind: 'ambiguous' }
  }

  // From here the branch is NOT at our commit. It must still be at the intended
  // parent for anything to be classified as harmless; anything else means the
  // branch moved for a reason we cannot explain.
  if (evidence.branchTip !== null && evidence.branchTip !== attempt.intendedParent) {
    return { kind: 'ambiguous' }
  }
  if (evidence.branchTip === null) {
    // The branch is unreadable — we cannot prove the ref did not move.
    return { kind: 'ambiguous' }
  }

  if (sha !== null && evidence.commitPresent) {
    // Crashed between A and B: the object exists, the ref provably never moved.
    return { kind: 'orphan_commit' }
  }
  if (attempt.promotionStarted) {
    // Crashed during/after A0.2, before A. Any objects present are a subset of
    // the APPROVED graph — unapproved content is impossible here, because A0.1
    // passed and promotion reads only the candidate store.
    return { kind: 'partial_promotion' }
  }
  return { kind: 'no_effect' }
}
