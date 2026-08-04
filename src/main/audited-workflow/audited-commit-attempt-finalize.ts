// Per-phase evidence writes and finalization for a commit attempt (Phase 8).
//
// Split from audited-commit-attempt-repository.ts so admission (which decides
// whether an attempt may exist) reviews separately from finalization (which
// records what happened), and so neither file needs a max-lines suppression.
//
// EVERY WRITE HERE IS PURE SQLITE. Git and filesystem work happen strictly
// between these calls, never inside their transactions.
import type Database from '../sqlite/sync-database'
import type { CommitAdvisoryCode, CommitReasonCode } from '../../shared/audited-commit-types'
import type { AuditedTaskState, CommitAttemptStatus } from '../../shared/audited-workflow-types'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type CompleteCommitResult = { ok: true } | { ok: false; reasonCode: CommitReasonCode }

/** Phase A0.1 evidence: the OID recomputed in a THROWAWAY store. */
export function recordVerifiedTree(
  db: Database.Database,
  attemptId: string,
  verifiedTreeOid: string
): void {
  db.prepare(`UPDATE audited_commit_attempts SET verified_tree_oid = ? WHERE id = ?`).run(
    verifiedTreeOid,
    attemptId
  )
}

/** Phase A0.2: set BEFORE any object moves into the real store. */
export function markPromotionStarted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_commit_attempts SET promotion_started = 1 WHERE id = ?`).run(attemptId)
}

export function markPromotionCompleted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_commit_attempts SET promotion_completed = 1 WHERE id = ?`).run(
    attemptId
  )
}

/** Phase A: recorded the moment commit-tree returns, BEFORE update-ref. */
export function recordCreatedCommit(
  db: Database.Database,
  attemptId: string,
  commitSha: string
): void {
  db.prepare(`UPDATE audited_commit_attempts SET created_commit_sha = ? WHERE id = ?`).run(
    commitSha,
    attemptId
  )
}

/**
 * Phase B finalization: the ref moved, so the commit is durable.
 *
 * Writes committed_sha, moves the task to `committed`, and records the attempt
 * complete — all in one transaction, so a reader never sees a committed task
 * without its SHA.
 */
export function completeCommitAttempt(
  db: Database.Database,
  args: { attemptId: string; taskId: string; commitSha: string },
  nowMs: number
): CompleteCommitResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE audited_commit_attempts
            SET status = 'completed', ref_updated = 1, promotion_completed = 1,
                reason_code = NULL, finalized_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'authorized'`
      )
      .run(nowMs, args.attemptId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const validation = validateAuditedTransition('commitComplete', 'committing')
    if (!validation.ok || validation.rule.to !== 'committed') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const moved = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'committed', committed_sha = ?, commit_attempt_status = 'completed',
                updated_at_ms = ?
          WHERE id = ? AND state = 'committing'`
      )
      .run(args.commitSha, nowMs, args.taskId)
    if (moved.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'committing', 'committed', 'control', 'commit_complete', NULL, NULL, ?)`
    ).run(args.taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Fails an attempt whose ref never moved, returning the task to
 * awaiting_human_approval so the human can retry or re-approve.
 *
 * `status` is the caller's evidence-backed choice between failed_no_effect and
 * failed_ambiguous — there is no bare `failed`.
 */
export function failCommitAttempt(
  db: Database.Database,
  args: {
    attemptId: string
    taskId: string
    status: Extract<CommitAttemptStatus, 'failed_no_effect' | 'failed_ambiguous' | 'abandoned'>
    reasonCode: CommitReasonCode
    /** Where the task should land; null leaves it alone. */
    toState: AuditedTaskState | null
    blockedReasonCode: string | null
  },
  nowMs: number
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE audited_commit_attempts
            SET status = ?, reason_code = ?, finalized_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'authorized'`
      )
      .run(args.status, args.reasonCode, nowMs, args.attemptId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    if (args.toState !== null) {
      const current = db
        .prepare(`SELECT state FROM audited_tasks WHERE id = ?`)
        .get(args.taskId) as { state: string } | undefined
      const fromState = current?.state ?? null
      if (fromState === 'committing') {
        db.prepare(
          `UPDATE audited_tasks
              SET state = ?, commit_attempt_status = ?, pre_block_state = ?,
                  blocked_reason_code = ?, blocked_phase = ?, updated_at_ms = ?
            WHERE id = ? AND state = 'committing'`
        ).run(
          args.toState,
          args.status,
          args.toState === 'blocked' ? 'committing' : null,
          args.blockedReasonCode,
          args.toState === 'blocked' ? 'commit' : null,
          nowMs,
          args.taskId
        )
        db.prepare(
          `INSERT INTO audited_transitions
             (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
           VALUES (?, 'committing', ?, 'control', 'commit_failed', ?, NULL, ?)`
        ).run(args.taskId, args.toState, args.reasonCode, nowMs)
      }
    }

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Records a Phase C/D outcome on a DURABLE commit.
 *
 * NEVER touches `status`: by the time either can be written the commit object,
 * the ref update, and committed_sha are all correct. Reporting them as failures
 * would be a lie that also invites a duplicate commit attempt.
 */
export function recordPostCommitAdvisory(
  db: Database.Database,
  attemptId: string,
  advisory: CommitAdvisoryCode | null,
  indexRefreshed: boolean
): void {
  db.prepare(
    `UPDATE audited_commit_attempts SET post_commit_advisory = ?, index_refreshed = ? WHERE id = ?`
  ).run(advisory, indexRefreshed ? 1 : 0, attemptId)
}
