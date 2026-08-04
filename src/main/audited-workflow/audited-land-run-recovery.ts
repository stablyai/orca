// Startup recovery for land attempts interrupted by a crash or restart
// (Phase 10).
//
// PIDs are deliberately NOT used for liveness — PID reuse makes "is it alive"
// unanswerable across a restart, and a wrong answer is worse than an honest
// classification. Recovery never fabricates an outcome and NEVER RE-RUNS A
// MUTATION; it reads Git evidence and records exactly what that evidence
// supports.
//
// A `completed` attempt is NEVER downgraded here. An L3/L4 finding is an advisory
// on a durable land, so a sweep that re-reads may only refine the advisory.
//
// THE PUBLICATION GATE IS NOT RE-EVALUATED. It is an admission precondition: this
// attempt was proven published when it was authorized. Re-checking it now would
// let an unrelated later publish failure strand a durable, already-applied land in
// failed_ambiguous — the exact opposite of "never downgrade a completed attempt".
import type Database from '../sqlite/sync-database'
import {
  failLandAttempt,
  getAuthorizedLandAttempts,
  getLandAttempt
} from './audited-land-attempt-repository'
import { classifyLandEvidence } from './audited-land-classification'
import { adoptLanded } from './audited-land-completion'
import { readLandEvidence } from './audited-land-evidence'

export type RecoveredLandAttempt = {
  taskId: string
  attemptId: string
  classification: string
}

/**
 * Reconciles every `authorized` attempt against real Git evidence.
 *
 * Async because it reads Git, so it must be awaited before handler registration
 * completes; each attempt is independently CAS-guarded, so ordering against the
 * other lanes' sweeps does not matter.
 */
export async function recoverInterruptedLandAttempts(
  db: Database.Database,
  nowMs: number
): Promise<RecoveredLandAttempt[]> {
  const recovered: RecoveredLandAttempt[] = []
  for (const { id, taskId } of getAuthorizedLandAttempts(db)) {
    const outcome = await recoverOneAttempt(db, id, taskId, nowMs)
    if (outcome) {
      recovered.push(outcome)
    }
  }
  return recovered
}

async function recoverOneAttempt(
  db: Database.Database,
  attemptId: string,
  taskId: string,
  nowMs: number
): Promise<RecoveredLandAttempt | null> {
  const attempt = getLandAttempt(db, attemptId)
  if (!attempt || attempt.status !== 'authorized') {
    return null
  }

  const evidence = await readLandEvidence(attempt)
  const verdict = classifyLandEvidence(attempt, evidence)

  switch (verdict.kind) {
    case 'exact_completion':
    case 'ref_moved':
    case 'ref_moved_worktree_partial': {
      // Idempotent adopt: the source ref moved, so the land genuinely happened
      // before the crash. The advisory records whether the checkout followed.
      adoptLanded(db, {
        taskId,
        attemptId,
        landedSha: verdict.landedSha,
        landedBaseSha: attempt.intendedBaseSha,
        reasonCode: 'landed_recovered',
        advisory: verdict.advisory
      })
      return { taskId, attemptId, classification: verdict.kind }
    }
    case 'no_effect': {
      // The ref provably never moved, so nothing in the user's repository
      // changed. There is nothing to clean and nothing to warn about.
      failLandAttempt(
        db,
        {
          attemptId,
          taskId,
          status: 'failed_no_effect',
          reasonCode: 'interrupted',
          block: false
        },
        nowMs
      )
      return { taskId, attemptId, classification: verdict.kind }
    }
    case 'ambiguous': {
      // Partial or unexplained evidence: block, keep it guarded, touch NO Git
      // state, and never offer an automatic fix.
      failLandAttempt(
        db,
        {
          attemptId,
          taskId,
          status: 'failed_ambiguous',
          reasonCode: 'landing_evidence_ambiguous',
          block: true
        },
        nowMs
      )
      return { taskId, attemptId, classification: verdict.kind }
    }
  }
}
