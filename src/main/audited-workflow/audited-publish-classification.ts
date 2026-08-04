// Evidence classification for an interrupted or unconfirmed push (Phase 9).
//
// Pure and side-effect-free: it takes an attempt row plus a remote probe and
// returns a verdict. Both the startup sweep and the user-triggered Recheck run
// THIS function, so the two routes can never disagree.
//
// Following the "every channel must match; anything partial is ambiguous"
// doctrine of audited-worktree-evidence-classification.ts — with one deliberate
// addition the local lanes do not need: `unknown_remote`. Distinguishing "we
// could not look" from "it did not happen" is the entire point. Collapsing them
// would either strand a published branch as failed or invite a duplicate push.
import type { PublishClassification } from '../../shared/audited-publish-types'
import type { PublishAttemptRow } from './audited-publish-attempt-repository'
import type { RemoteRefProbe } from './audited-publish-remote'

export type PublishEvidence = {
  /** The remote ref as last read. A failed probe means we could not look. */
  remote: RemoteRefProbe
}

export type PublishVerdict =
  | { kind: 'published'; pushedSha: string }
  | { kind: 'no_effect' }
  | { kind: 'ambiguous' }
  | { kind: 'unknown_remote' }

export function classifyPublishEvidence(
  attempt: PublishAttemptRow,
  evidence: PublishEvidence
): PublishVerdict {
  // Nothing was ever sent: the push had not spawned when we stopped. No probe is
  // needed, so this holds even while the remote is unreadable.
  if (!attempt.pushStarted) {
    return { kind: 'no_effect' }
  }

  if (!evidence.remote.ok) {
    // We could not look. NOT a failure and NOT a success — the attempt stays
    // live so no second push can start until this is resolved.
    return { kind: 'unknown_remote' }
  }

  const remoteSha = evidence.remote.sha

  // The remote carries exactly what we intended to publish.
  if (remoteSha === attempt.intendedSha) {
    return { kind: 'published', pushedSha: attempt.intendedSha }
  }

  // The remote is still at our lease value, so the push provably did not land.
  if (remoteSha !== null && remoteSha === attempt.expectedRemoteSha) {
    return { kind: 'no_effect' }
  }

  // We expected the ref to be absent and it still is: the create never happened.
  if (remoteSha === null && attempt.expectedRemoteSha === null) {
    return { kind: 'no_effect' }
  }

  // The remote is at some third value, or vanished under us. Something we did
  // not do has happened; never auto-remediated.
  return { kind: 'ambiguous' }
}

export function verdictToClassification(verdict: PublishVerdict): PublishClassification {
  return verdict.kind
}
