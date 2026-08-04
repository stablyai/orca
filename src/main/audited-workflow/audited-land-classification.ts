// Decides what an interrupted land attempt actually did, from Git evidence alone
// (Phase 10).
//
// PURE AND SIDE-EFFECT-FREE. The live protocol and the two recovery routes
// (startup sweep, user Recheck) all call this, so none of them can disagree about
// what a given world state means.
//
// THE RULE THAT ORDERS EVERYTHING: the ref update is the durable boundary. Once
// the source branch carries the intended sha, the land HAPPENED — the only
// remaining question is whether the index/worktree followed, which selects an
// advisory, never a failure.
import type { LandingAdvisoryCode, LandingClassification } from '../../shared/audited-landing-types'
import type { LandAttemptRow } from './audited-land-attempt-repository'
import type { LandEvidence } from './audited-land-evidence'

export type LandVerdict =
  | { kind: 'exact_completion'; landedSha: string; advisory: null }
  | { kind: 'ref_moved'; landedSha: string; advisory: LandingAdvisoryCode }
  | { kind: 'ref_moved_worktree_partial'; landedSha: string; advisory: LandingAdvisoryCode }
  | { kind: 'no_effect' }
  | { kind: 'ambiguous' }

/**
 * Classifies one attempt against the evidence read from its source repository.
 *
 * Ordering is load-bearing: identity is checked before anything is believed, then
 * the durable-boundary question ("did the ref move?"), and only then the
 * worktree question. Reversing the last two would let a clean worktree mask an
 * unmoved ref.
 */
export function classifyLandEvidence(attempt: LandAttemptRow, evidence: LandEvidence): LandVerdict {
  // A different repository at the recorded path, or a tip we could not read at
  // all: nothing can be concluded, so nothing is concluded.
  if (!evidence.repoIdentityIntact || evidence.unreadable || evidence.branchTip === null) {
    return { kind: 'ambiguous' }
  }

  const tip = evidence.branchTip

  // ---- The ref never moved. ----
  if (tip === attempt.intendedBaseSha) {
    // The CAS is atomic, so a tip still at base proves the update did not apply,
    // regardless of how far the attempt believed it had progressed.
    return { kind: 'no_effect' }
  }

  // ---- The ref moved to exactly what we intended: the land is DURABLE. ----
  if (tip === attempt.intendedSha) {
    if (evidence.headCommit && evidence.worktreeClean) {
      // HEAD followed the ref and the tree matches: nothing is outstanding.
      return { kind: 'exact_completion', landedSha: tip, advisory: null }
    }
    if (!evidence.worktreeClean) {
      // The index/worktree update ran partially, or files changed under us. NEVER
      // re-run read-tree -m -u from here: it would either refuse or overwrite
      // changes we cannot account for.
      return {
        kind: 'ref_moved_worktree_partial',
        landedSha: tip,
        advisory: 'worktree_update_failed'
      }
    }
    // Clean tree but HEAD does not read as the intended sha — the update never
    // reached the index. Durable land, stale checkout.
    return { kind: 'ref_moved', landedSha: tip, advisory: 'worktree_update_failed' }
  }

  // ---- The tip is somewhere else entirely. ----
  // The intended sha being fully reachable from the tip would mean someone landed
  // it and then moved on; that is a durable land by any honest reading, but it is
  // NOT what this attempt was authorized to produce, so it stays guarded rather
  // than adopted under a sha we never wrote.
  return { kind: 'ambiguous' }
}

/** The closed classification name, for the read-only Recheck result. */
export function landVerdictToClassification(verdict: LandVerdict): LandingClassification {
  return verdict.kind
}
