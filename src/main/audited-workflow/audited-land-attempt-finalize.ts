// Per-phase evidence writes and finalization for a land attempt (Phase 10).
//
// Split from audited-land-attempt-repository.ts so admission (which decides
// whether an attempt may exist) reviews separately from finalization (which
// records what happened), and so neither file needs a max-lines suppression.
//
// EVERY WRITE HERE IS PURE SQLITE. Git and filesystem work happen strictly
// between these calls, never inside their transactions.
import type Database from '../sqlite/sync-database'
import type { LandAttemptStatus, LandingAdvisoryCode } from '../../shared/audited-landing-types'
import type { LandingReasonCode } from '../../shared/audited-workflow-types'
import { validateAuditedTransition } from './audited-workflow-state-machine'

/** L2 marker: set BEFORE update-ref spawns, so a crash mid-command is classifiable. */
export function markRefUpdateStarted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_land_attempts SET ref_update_started = 1 WHERE id = ?`).run(attemptId)
}

export function markRefUpdateCompleted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_land_attempts SET ref_update_completed = 1 WHERE id = ?`).run(
    attemptId
  )
}

/** L3 marker: set BEFORE read-tree spawns, for the same reason. */
export function markWorktreeUpdateStarted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_land_attempts SET worktree_update_started = 1 WHERE id = ?`).run(
    attemptId
  )
}

export function markWorktreeUpdateCompleted(db: Database.Database, attemptId: string): void {
  db.prepare(`UPDATE audited_land_attempts SET worktree_update_completed = 1 WHERE id = ?`).run(
    attemptId
  )
}

export type CompleteLandArgs = {
  attemptId: string
  taskId: string
  landedSha: string
  landedBaseSha: string
  /** 'landed' for a fresh fast-forward, 'landed_recovered' for an idempotent adopt. */
  reasonCode: Extract<LandingReasonCode, 'landed' | 'landed_recovered'>
  advisory: LandingAdvisoryCode | null
}

/**
 * L2 finalization: the source ref moved, so the land is DURABLE.
 *
 * Writes landed_sha/landed_base_sha, moves the task to the TERMINAL `landed`
 * state, and records the attempt complete — all in one transaction, so a reader
 * never sees a landed task without its SHA.
 *
 * `advisory` may be non-null on a fully successful land: an L3/L4 problem is a
 * caveat on durable state, never a failure. status is ALWAYS 'completed' here.
 */
export function completeLandAttempt(
  db: Database.Database,
  args: CompleteLandArgs,
  nowMs: number
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE audited_land_attempts
            SET status = 'completed', ref_update_completed = 1, landed_sha = ?,
                landing_advisory = ?, reason_code = ?, finalized_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'authorized'`
      )
      .run(args.landedSha, args.advisory, args.reasonCode, nowMs, args.attemptId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    const validation = validateAuditedTransition('landSucceed', 'landing')
    if (!validation.ok || validation.rule.to !== 'landed') {
      db.exec('ROLLBACK')
      return false
    }

    const moved = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'landed', landed_sha = ?, landed_base_sha = ?,
                landing_reason_code = ?, landing_advisory = ?,
                land_attempt_status = 'completed', updated_at_ms = ?
          WHERE id = ? AND state = 'landing'`
      )
      .run(args.landedSha, args.landedBaseSha, args.reasonCode, args.advisory, nowMs, args.taskId)
    if (moved.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'landing', 'landed', 'control', 'land_complete', ?, NULL, ?)`
    ).run(args.taskId, args.reasonCode, nowMs)

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export type FailLandArgs = {
  attemptId: string
  taskId: string
  status: Extract<LandAttemptStatus, 'failed_no_effect' | 'failed_ambiguous' | 'abandoned'>
  reasonCode: LandingReasonCode
  /**
   * Whether to BLOCK rather than return to `committed`. True only for ambiguous
   * evidence, which must stay guarded and never be auto-remediated.
   */
  block: boolean
}

/**
 * Fails an attempt whose source ref provably never moved.
 *
 * The task returns to `committed` (via landRefuse) rather than `blocked`: nothing
 * about the local commit or its publication is in doubt, so Land is simply
 * offered again. Only ambiguous evidence blocks.
 *
 * `status` is the caller's evidence-backed choice between failed_no_effect and
 * failed_ambiguous — there is no bare `failed`.
 */
export function failLandAttempt(db: Database.Database, args: FailLandArgs, nowMs: number): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE audited_land_attempts
            SET status = ?, reason_code = ?, finalized_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'authorized'`
      )
      .run(args.status, args.reasonCode, nowMs, args.attemptId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    const current = db.prepare(`SELECT state FROM audited_tasks WHERE id = ?`).get(args.taskId) as
      | { state: string }
      | undefined
    if (current?.state === 'landing') {
      const toState = args.block ? 'blocked' : 'committed'
      db.prepare(
        `UPDATE audited_tasks
            SET state = ?, land_attempt_status = ?, landing_reason_code = ?,
                pre_block_state = ?, blocked_reason_code = ?, blocked_phase = ?,
                updated_at_ms = ?
          WHERE id = ? AND state = 'landing'`
      ).run(
        toState,
        args.status,
        args.reasonCode,
        args.block ? 'landing' : null,
        args.block ? 'land_attempt_evidence_ambiguous' : null,
        args.block ? 'land' : null,
        nowMs,
        args.taskId
      )
      db.prepare(
        `INSERT INTO audited_transitions
           (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
         VALUES (?, 'landing', ?, 'control', 'land_failed', ?, NULL, ?)`
      ).run(args.taskId, toState, args.reasonCode, nowMs)
    }

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
