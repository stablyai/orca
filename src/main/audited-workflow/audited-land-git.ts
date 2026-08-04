// Phases L1-L4 — the Git side of the local landing protocol (Phase 10).
//
// PHASE ORDER IS LOAD-BEARING:
//   L1  re-verify readiness   -> HEAD symbolic, tip at base, tree clean
//   L2  update-ref <new> <old> -> the ONE narrowly authorized ref update
//   L3  read-tree -m -u        -> move the index AND the working tree
//   L4  re-read + compare      -> post-land verification (advisory)
//
// L2 IS THE DURABLE BOUNDARY. A crash before it leaves the user's branch exactly
// where it was; a crash after it leaves a landed branch whose working tree may be
// stale — recoverable, and never reported as a failed land. That asymmetry is the
// entire reason the phases are ordered this way.
//
// Orca's own Git surfaces refuse mutations on AUDITED worktrees; this module is
// the inverse — it runs only in the user's SOURCE repository, and
// runAuditedGitLandWrite refuses to spawn anywhere else.
import type { LandingReasonCode } from '../../shared/audited-workflow-types'
import {
  buildLandReadTreeArgv,
  buildUpdateRefCasArgv,
  runAuditedGitLandWrite
} from './audited-worktree-commands'

export type RefUpdateOutcome = { ok: true } | { ok: false; reasonCode: LandingReasonCode }

/**
 * L2 — the compare-and-swap fast-forward.
 *
 * The three-operand form fails loudly if the branch moved under us, which is the
 * only concurrency guarantee Git itself provides here. A non-zero exit is NOT
 * proof nothing happened, so the caller re-reads evidence before concluding.
 */
export async function runLandRefUpdate(args: {
  sourceRepoPath: string
  branchName: string
  committedSha: string
  expectedBaseSha: string
}): Promise<RefUpdateOutcome> {
  const result = await runAuditedGitLandWrite(
    buildUpdateRefCasArgv(args.branchName, args.committedSha, args.expectedBaseSha),
    args.sourceRepoPath
  )
  if (!result.ok) {
    // A CAS rejection and a genuine write failure are indistinguishable from the
    // exit code alone, so the caller classifies from evidence rather than trust.
    return { ok: false, reasonCode: 'fast_forward_failed' }
  }
  return { ok: true }
}

/**
 * L3 — move the index and the working tree to the landed commit.
 *
 * Returns a boolean rather than a result: by the time this runs the ref has
 * ALREADY moved, so a failure is an ADVISORY, never a land failure. The user's
 * history is correct either way; only their checkout may be stale.
 *
 * `-m` makes this refuse rather than clobber if a file changed under us, which is
 * exactly the behavior we want for a tree we do not own.
 */
export async function runLandWorktreeUpdate(args: {
  sourceRepoPath: string
  baseSha: string
  committedSha: string
}): Promise<boolean> {
  const result = await runAuditedGitLandWrite(
    buildLandReadTreeArgv(args.baseSha, args.committedSha),
    args.sourceRepoPath
  )
  return result.ok
}
