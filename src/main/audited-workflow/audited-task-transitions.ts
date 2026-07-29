// Transition persistence with optimistic compare-and-swap. Isolated from
// audited-task-repository.ts so the concurrency-critical write path is easy
// to review and test independent of task creation / listing.
//
// Race eliminated: a naive "read current state, validate, then write" flow is
// vulnerable to two callers reading the same prior state and both committing
// — the second write silently clobbers the first and records a from_state
// that no longer reflects real history at the time of the write. Here the
// UPDATE's WHERE clause requires the row to still be in `fromState` at write
// time; SQLite's row-level atomicity guarantees at most one caller's UPDATE
// can match. A caller that loses the race gets changes() === 0 and returns
// lock_contended without writing any transition row — never a misleading one.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskActor, AuditedTaskState } from '../../shared/audited-workflow-types'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'

export type ApplyTransitionArgs = {
  taskId: string
  fromState: AuditedTaskState
  toState: AuditedTaskState
  actor: AuditedTaskActor
  eventType: string
  reasonCode?: string | null
  preBlockState?: AuditedTaskState | null
  blockedReasonCode?: string | null
  blockedPhase?: string | null
}

export type ApplyTransitionResult =
  | { ok: true; task: AuditedTaskRow }
  | { ok: false; reasonCode: 'task_not_found' | 'lock_contended' }

function getTaskRow(db: Database.Database, taskId: string): AuditedTaskRow | null {
  const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToTask(row) : null
}

function recordTransition(
  db: Database.Database,
  taskId: string,
  fromState: AuditedTaskState | null,
  toState: AuditedTaskState,
  actor: AuditedTaskActor,
  eventType: string,
  reasonCode: string | null,
  detailJson: string | null,
  atMs: number
): void {
  db.prepare(
    `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, fromState, toState, actor, eventType, reasonCode, detailJson, atMs)
}

/**
 * Applies a compare-and-swap transition: the row is updated ONLY if its
 * current `state` column still equals `args.fromState` at write time. Must
 * be called with `args.fromState` freshly read by the caller immediately
 * before this call (see audited-task-repository.ts's applyTransition,
 * which re-reads inside the same BEGIN IMMEDIATE this function opens).
 *
 * On success, the persisted from_state is exactly the WHERE clause's
 * fromState — it is provably the true prior DB state, not a snapshot that
 * might have gone stale between read and write.
 */
export function applyTransitionCas(
  db: Database.Database,
  args: ApplyTransitionArgs,
  nowMs: number
): ApplyTransitionResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, args.taskId)
    if (!existing) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }

    const updateResult = db
      .prepare(
        `UPDATE audited_tasks
           SET state = ?,
               pre_block_state = ?,
               blocked_reason_code = ?,
               blocked_phase = ?,
               updated_at_ms = ?
         WHERE id = ? AND state = ?`
      )
      .run(
        args.toState,
        args.preBlockState !== undefined ? args.preBlockState : existing.preBlockState,
        args.blockedReasonCode !== undefined ? args.blockedReasonCode : existing.blockedReasonCode,
        args.blockedPhase !== undefined ? args.blockedPhase : existing.blockedPhase,
        nowMs,
        args.taskId,
        args.fromState
      )

    // changes() !== 1 means the row's state no longer matched fromState —
    // either the task vanished (impossible mid-transaction under
    // BEGIN IMMEDIATE's write lock) or a concurrent transition already moved
    // it. Either way: no transition row is written, so history never claims
    // a from_state that wasn't real at write time.
    if (updateResult.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    recordTransition(
      db,
      args.taskId,
      args.fromState,
      args.toState,
      args.actor,
      args.eventType,
      args.reasonCode ?? null,
      null,
      nowMs
    )

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const updated = getTaskRow(db, args.taskId)
  if (!updated) {
    throw new Error(`audited task ${args.taskId} vanished after transition`)
  }
  return { ok: true, task: updated }
}
