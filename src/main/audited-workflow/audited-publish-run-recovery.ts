// Startup recovery for publish attempts interrupted by a crash or restart
// (Phase 9).
//
// STRICTLY READ-ONLY WITH RESPECT TO THE REMOTE. It builds ls-remote and nothing
// else — recovery CLASSIFIES, it does not act. A push at startup would be a
// network mutation with no human intent behind it.
//
// PIDs are deliberately NOT used for liveness, following the doctrine every other
// recovery module in this lane states: PID reuse makes "is it alive" unanswerable
// across a restart, and a wrong answer is worse than an honest classification.
//
// An attempt whose remote cannot be read stays `authorized` and is left for the
// user's explicit Recheck. That is not an omission: leaving it live is precisely
// what stops a second push from starting while the first outcome is unknown.
import type Database from '../sqlite/sync-database'
import type { PublishClassification } from '../../shared/audited-publish-types'
import {
  completePublishAttempt,
  failPublishAttempt,
  getAuthorizedPublishAttempts,
  getPublishAttempt
} from './audited-publish-attempt-repository'
import { classifyPublishEvidence } from './audited-publish-classification'
import { probeRemoteRef } from './audited-publish-remote'

export type RecoveredPublishAttempt = {
  taskId: string
  attemptId: string
  classification: PublishClassification
}

/**
 * Reconciles every `authorized` attempt against the real remote.
 *
 * Async because it reads the network; each attempt is independently CAS-guarded,
 * so ordering against the fire-and-forget worktree reconciliation does not
 * matter.
 */
export async function recoverInterruptedPublishAttempts(
  db: Database.Database,
  nowMs: number
): Promise<RecoveredPublishAttempt[]> {
  const recovered: RecoveredPublishAttempt[] = []
  for (const { id, taskId } of getAuthorizedPublishAttempts(db)) {
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
): Promise<RecoveredPublishAttempt | null> {
  const attempt = getPublishAttempt(db, attemptId)
  if (!attempt || attempt.status !== 'authorized') {
    return null
  }
  const task = db.prepare(`SELECT worktree_path FROM audited_tasks WHERE id = ?`).get(taskId) as
    | { worktree_path: string | null }
    | undefined
  if (!task?.worktree_path) {
    return null
  }

  const probe = await probeRemoteRef(
    task.worktree_path,
    attempt.intendedRemote,
    attempt.intendedBranch
  )
  const verdict = classifyPublishEvidence(attempt, { remote: probe })

  switch (verdict.kind) {
    case 'published': {
      // Idempotent adopt: the remote genuinely carries the audited sha.
      // The review request is NOT attempted here — a network mutation at startup
      // needs human intent. The advisory stays null and the UI offers
      // Create review request.
      completePublishAttempt(db, { attemptId, taskId, pushedSha: verdict.pushedSha }, nowMs)
      return { taskId, attemptId, classification: 'published' }
    }
    case 'no_effect': {
      failPublishAttempt(
        db,
        { attemptId, taskId, status: 'failed_no_effect', reasonCode: 'interrupted', block: false },
        nowMs
      )
      return { taskId, attemptId, classification: 'no_effect' }
    }
    case 'ambiguous': {
      // The remote is at a value we cannot explain. Block, keep it guarded,
      // touch NO remote state, and never offer an automatic fix.
      failPublishAttempt(
        db,
        {
          attemptId,
          taskId,
          status: 'failed_ambiguous',
          reasonCode: 'push_evidence_ambiguous',
          block: true
        },
        nowMs
      )
      return { taskId, attemptId, classification: 'ambiguous' }
    }
    case 'unknown_remote': {
      // We could not look. Write NOTHING: the attempt stays live so the user's
      // explicit Recheck is the only way it resolves.
      return { taskId, attemptId, classification: 'unknown_remote' }
    }
  }
}
