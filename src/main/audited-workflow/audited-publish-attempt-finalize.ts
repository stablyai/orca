// Per-phase evidence writes and finalization for a publish attempt (Phase 9).
//
// Split from audited-publish-attempt-repository.ts so admission (which decides
// whether an attempt may exist) reviews separately from finalization (which
// records what happened), and so neither file needs a max-lines suppression.
//
// THE CENTRAL RULE: once the push is CONFIRMED on the remote, the attempt is
// permanently `completed`. Every review-request outcome after that point is an
// advisory, written to publish_advisory — which NEVER holds a PublishReasonCode.
// Marking a durable publish as failed would be a lie that also invites a
// duplicate push.
//
// EVERY WRITE HERE IS PURE SQLITE.
import type Database from '../sqlite/sync-database'
import type { PublishAdvisoryCode, PublishReasonCode } from '../../shared/audited-publish-types'
import type { PublishAttemptStatus } from '../../shared/audited-workflow-types'
import type { HostedReviewProvider } from '../../shared/hosted-review'

/** Records the lease captured before the push, so recovery knows our premise. */
export function recordPublishLease(
  db: Database.Database,
  attemptId: string,
  args: { remote: string; expectedRemoteSha: string | null }
): void {
  db.prepare(
    `UPDATE audited_publish_attempts SET intended_remote = ?, expected_remote_sha = ?
      WHERE id = ?`
  ).run(args.remote, args.expectedRemoteSha, attemptId)
}

/** Set BEFORE the push spawns, so a crash mid-push is classifiable. */
export function markPushStarted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_publish_attempts SET push_started = 1 WHERE id = ?`).run(attemptId)
}

/**
 * Finalization: the remote ref was CONFIRMED to carry the audited sha.
 *
 * Writes published_sha and records the attempt complete in one transaction, so a
 * reader never sees a completed attempt without its sha. The task state is NOT
 * touched — it stays `committed`.
 */
export function completePublishAttempt(
  db: Database.Database,
  args: { attemptId: string; taskId: string; pushedSha: string },
  nowMs: number
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE audited_publish_attempts
            SET status = 'completed', push_completed = 1, pushed_sha = ?,
                reason_code = NULL, finalized_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'authorized'`
      )
      .run(args.pushedSha, nowMs, args.attemptId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    db.prepare(
      `UPDATE audited_tasks
          SET publish_attempt_status = 'completed', published_sha = ?, updated_at_ms = ?
        WHERE id = ?`
    ).run(args.pushedSha, nowMs, args.taskId)

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'committed', 'committed', 'control', 'publish_complete', NULL, NULL, ?)`
    ).run(args.taskId, nowMs)

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Fails an attempt whose push provably did not land, or whose evidence is
 * ambiguous.
 *
 * `status` is the caller's evidence-backed choice between failed_no_effect and
 * failed_ambiguous — there is no bare `failed`. The task state stays `committed`
 * in both cases; only an ambiguous outcome additionally blocks it, and even then
 * committed_sha is untouched.
 */
export function failPublishAttempt(
  db: Database.Database,
  args: {
    attemptId: string
    taskId: string
    status: Extract<PublishAttemptStatus, 'failed_no_effect' | 'failed_ambiguous' | 'abandoned'>
    reasonCode: PublishReasonCode
    /** Whether to block the task. Only ambiguous push evidence does. */
    block: boolean
  },
  nowMs: number
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE audited_publish_attempts
            SET status = ?, reason_code = ?, finalized_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'authorized'`
      )
      .run(args.status, args.reasonCode, nowMs, args.attemptId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    if (args.block) {
      // The local commit is untouched and correct; only the publish is in doubt.
      // pre_block_state is `committed` so Retry returns there, not to a
      // pre-commit state.
      db.prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', publish_attempt_status = ?, pre_block_state = 'committed',
                blocked_reason_code = 'publish_process_failed', blocked_phase = 'land',
                updated_at_ms = ?
          WHERE id = ? AND state = 'committed'`
      ).run(args.status, nowMs, args.taskId)
      db.prepare(
        `INSERT INTO audited_transitions
           (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
         VALUES (?, 'committed', 'blocked', 'control', 'publish_failed', ?, NULL, ?)`
      ).run(args.taskId, args.reasonCode, nowMs)
    } else {
      db.prepare(
        `UPDATE audited_tasks SET publish_attempt_status = ?, updated_at_ms = ? WHERE id = ?`
      ).run(args.status, nowMs, args.taskId)
      db.prepare(
        `INSERT INTO audited_transitions
           (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
         VALUES (?, 'committed', 'committed', 'control', 'publish_failed', ?, NULL, ?)`
      ).run(args.taskId, args.reasonCode, nowMs)
    }

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Records a review-request outcome on a CONFIRMED publish.
 *
 * NEVER touches `status` or `pushed_sha`: by the time this can be written, the
 * remote provably carries the audited sha. The advisory is always a
 * PublishAdvisoryCode — the type makes storing a PublishReasonCode here
 * impossible.
 */
export function recordReviewOutcome(
  db: Database.Database,
  args: {
    attemptId: string
    taskId: string
    advisory: PublishAdvisoryCode
    provider: HostedReviewProvider | null
    number: number | null
    url: string | null
    created: boolean
  }
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE audited_publish_attempts
          SET publish_advisory = ?, review_provider = ?, review_number = ?, review_url = ?,
              review_created = ?
        WHERE id = ?`
    ).run(args.advisory, args.provider, args.number, args.url, args.created ? 1 : 0, args.attemptId)
    db.prepare(`UPDATE audited_tasks SET review_provider = ?, review_number = ? WHERE id = ?`).run(
      args.provider,
      args.number,
      args.taskId
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
