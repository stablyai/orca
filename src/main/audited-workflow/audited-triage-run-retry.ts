// Retry path for a triage run blocked by a retryable failure. Split from
// audited-triage-run-repository.ts to stay under the max-lines budget — see
// that file's header for why start/finalize live there; this file owns only
// the symmetric "blocked -> triaging" retry CAS.
import type Database from '../sqlite/sync-database'
import type { TriageReasonCode } from '../../shared/audited-workflow-types'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { generateRunId, getTaskRow } from './audited-triage-run-repository'

// Reason codes that may legally be retried. Kept in this file (not the
// renderer's isRetryableTriageReasonCode) because the repository is the
// authority that must refuse an illegal retry server-side — the renderer
// helper only controls whether a button is drawn, never enforcement.
const RETRYABLE_TRIAGE_REASON_CODES: readonly TriageReasonCode[] = [
  'provider_unavailable',
  'provider_timeout',
  'provider_error',
  'output_invalid',
  'interrupted'
]

export type RetryTriageRunResult =
  | { ok: true; runId: string; task: AuditedTaskRow }
  | {
      ok: false
      reasonCode: 'task_not_found' | 'illegal_transition' | 'lock_contended'
    }

/**
 * Retries triage for a task currently `blocked` by a retryable triage
 * failure. Requires, atomically:
 *  - `state === 'blocked'`
 *  - `pre_block_state === 'triaging'` (the block originated from triage,
 *    never from a later phase reusing the generic blocked state)
 *  - `triage_blocked_reason_code` is set and is in the retryable set
 * All three checks plus the `blocked -> triaging` CAS write and the fresh
 * `running` triage_runs insert happen inside one BEGIN IMMEDIATE
 * transaction — the same one-running-run invariant and CAS discipline as
 * startTriageRun. A caller whose precondition read is stale (task moved,
 * or already retried by a concurrent caller) loses the CAS and gets
 * `illegal_transition`/`lock_contended`, never a duplicated running run.
 */
export function retryTriageRun(
  db: Database.Database,
  taskId: string,
  nowMs: number
): RetryTriageRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, taskId)
    if (!existing) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }
    const blockedReasonCode = existing.triageBlockedReasonCode
    const isRetryableBlock =
      existing.state === 'blocked' &&
      existing.preBlockState === 'triaging' &&
      blockedReasonCode !== null &&
      RETRYABLE_TRIAGE_REASON_CODES.includes(blockedReasonCode)
    if (!isRetryableBlock) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const updateResult = db
      .prepare(
        `UPDATE audited_tasks
           SET state = 'triaging',
               pre_block_state = NULL,
               blocked_reason_code = NULL,
               blocked_phase = NULL,
               triage_blocked_reason_code = NULL,
               triage_run_status = 'running',
               updated_at_ms = ?
         WHERE id = ? AND state = 'blocked'`
      )
      .run(nowMs, taskId)
    if (updateResult.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const runId = generateRunId()
    try {
      db.prepare(
        `INSERT INTO audited_triage_runs (id, task_id, status, started_at_ms) VALUES (?, ?, 'running', ?)`
      ).run(runId, taskId, nowMs)
    } catch {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'blocked', 'triaging', 'human', 'triage_retried', ?, NULL, ?)`
    ).run(taskId, blockedReasonCode, nowMs)

    db.exec('COMMIT')
    const task = getTaskRow(db, taskId)
    if (!task) {
      throw new Error(`audited task ${taskId} vanished after retrying triage`)
    }
    return { ok: true, runId, task }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
