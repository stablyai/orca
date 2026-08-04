// Phase D — mandatory post-commit worktree verification (Phase 8).
//
// WHY IT IS MANDATORY. The update-ref CAS protects ONLY the branch ref. It proves
// nobody moved the branch; it proves nothing about concurrent filesystem edits, so
// a file written between A0 and C leaves the worktree no longer matching what was
// committed. Phase D is what detects that.
//
// ON DRIFT, THE COMMIT IS NOT ROLLED BACK AND NOT REPORTED AS FAILED. The commit
// object, the ref update, and committed_sha are all durable and correct — they
// faithfully record the approved tree. Only the WORKTREE has moved on. Marking a
// correct commit as failed would be a lie that also invites a duplicate attempt;
// the honest remedy for the new changes is a fresh candidate, not a rollback.
import type { CommitAdvisoryCode } from '../../shared/audited-commit-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import { deriveCandidateTree } from './audited-candidate-identity'
import { readBranchTip, readHeadCommit } from './audited-commit-git'
import { canonicalizeAllowingMissing, isPathInside } from './audited-worktree-managed-root'

export type PostCommitVerification = {
  /** Null when the worktree still matches the commit. */
  advisory: CommitAdvisoryCode | null
}

export type PostCommitVerifyArgs = {
  attemptId: string
  userDataPath: string
  worktreePath: string
  sourceRepoPath: string
  branchName: string
  committedSha: string
  committedTreeOid: string
  wslDistro: string | null
  hostId: string
}

/**
 * Verifies the worktree still matches the commit.
 *
 * Every outcome is advisory: this function cannot fail a commit. A read failure
 * is reported as drift-unknown rather than silently treated as "clean", because
 * absence of evidence is not evidence of a match.
 */
export async function verifyWorktreeAfterCommit(
  args: PostCommitVerifyArgs
): Promise<PostCommitVerification> {
  // HEAD and the branch tip must both be at the new commit. This is the
  // post-commit analogue of the Phase 3 ladder, which expects base_commit and
  // would therefore report drift for every committed task.
  const head = await readHeadCommit(args.worktreePath)
  const tip = await readBranchTip(args.worktreePath, args.branchName)
  if (head !== args.committedSha || tip !== args.committedSha) {
    return { advisory: 'post_commit_drift_detected' }
  }

  // Re-derive from the refreshed worktree. Ephemeral: nothing is persisted, so
  // this check cannot itself pollute the object store.
  const rederived = await deriveCandidateTree({
    runId: `${args.attemptId}_postverify`,
    userDataPath: args.userDataPath,
    worktreePath: args.worktreePath,
    sourceRepoPath: args.sourceRepoPath,
    baseCommit: args.committedSha,
    wslDistro: args.wslDistro,
    hostId: args.hostId,
    retention: 'ephemeral'
  })

  if (!rederived.ok) {
    // `empty_change_set` is the SUCCESS signal here: it means the worktree
    // produces exactly the committed tree, so there is nothing uncommitted left.
    if (rederived.reasonCode === 'empty_change_set') {
      return { advisory: null }
    }
    // Any other failure means we could not establish a match. Reported as an
    // advisory, never as a commit failure.
    return { advisory: 'post_commit_drift_detected' }
  }

  // A derivable non-empty tree means uncommitted changes exist beyond the commit.
  return rederived.treeOid === args.committedTreeOid
    ? { advisory: null }
    : { advisory: 'post_commit_drift_detected' }
}

/**
 * The post-commit analogue of verifyAuditedWorktree.
 *
 * Phase 3's verifier requires HEAD and the branch tip to equal base_commit and
 * has no trusted-commit escape hatch — by design, per its own comment that "a
 * later trusted-commit phase will introduce its own explicit expected-HEAD policy
 * with its own evidence rather than a boolean that disables this invariant".
 * This is that policy: same shape, different expected value. The Phase 3 verifier
 * is left untouched.
 */
export async function verifyCommittedWorktree(input: {
  worktreePath: string
  expectedWorktreePath: string
  managedRoot: string
  branchName: string
  committedSha: string
}): Promise<{ ok: true } | { ok: false; reasonCode: WorktreeReasonCode }> {
  const canonical = canonicalizeAllowingMissing(input.worktreePath)
  if (!isPathInside(canonical, canonicalizeAllowingMissing(input.managedRoot))) {
    return { ok: false, reasonCode: 'worktree_path_outside_managed_root' }
  }
  const head = await readHeadCommit(canonical)
  if (head === null) {
    return { ok: false, reasonCode: 'worktree_unreadable' }
  }
  if (head !== input.committedSha) {
    return { ok: false, reasonCode: 'head_moved_from_base_commit' }
  }
  const tip = await readBranchTip(canonical, input.branchName)
  if (tip === null) {
    return { ok: false, reasonCode: 'worktree_unreadable' }
  }
  if (tip !== input.committedSha) {
    return { ok: false, reasonCode: 'branch_tip_moved_from_base_commit' }
  }
  return { ok: true }
}
