// Persistence for triage runs (Phase 2). Isolated from
// audited-task-transitions.ts because starting/finalizing a triage run
// combines a task-state CAS with a row in audited_triage_runs inside one
// transaction — a distinct concurrency unit from the generic transition CAS.
import type Database from '../sqlite/sync-database'
import type {
  AuditedAcceptanceCriterion,
  AuditedTaskState,
  TriageDecision,
  TriageReasonCode
} from '../../shared/audited-workflow-types'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'

export type StartTriageRunResult =
  | { ok: true; runId: string; task: AuditedTaskRow }
  | { ok: false; reasonCode: 'task_not_found' | 'illegal_transition' | 'lock_contended' }

// Why: exported (not module-private) so audited-triage-run-retry.ts — split
// out to stay under the max-lines budget — can share the exact same run-id
// generation and task-row read helpers rather than duplicating them.
export function generateRunId(): string {
  return `triage_${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`
}

export function getTaskRow(db: Database.Database, taskId: string): AuditedTaskRow | null {
  const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToTask(row) : null
}

/**
 * Starts a triage run: CAS the task from `selected` to `triaging` and insert
 * a `running` audited_triage_runs row, both inside one BEGIN IMMEDIATE
 * transaction. Two mechanisms independently prevent a duplicate concurrent
 * start:
 *  - the task-state CAS (`WHERE state = 'selected'`) — a second caller sees
 *    the row already in `triaging` and loses the race;
 *  - the partial unique index on audited_triage_runs(task_id) WHERE
 *    status='running' — even if two callers somehow both observed
 *    `selected` (impossible under BEGIN IMMEDIATE's write lock, but defended
 *    in depth), only one INSERT can satisfy the index.
 * Both failures collapse to the same closed `lock_contended` reason code —
 * the caller doesn't need to distinguish which mechanism fired.
 */
export function startTriageRun(
  db: Database.Database,
  taskId: string,
  nowMs: number
): StartTriageRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, taskId)
    if (!existing) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }
    if (existing.state !== 'selected') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const updateResult = db
      .prepare(
        `UPDATE audited_tasks SET state = 'triaging', triage_run_status = 'running', updated_at_ms = ? WHERE id = ? AND state = 'selected'`
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
      // Why: the partial unique index (task_id WHERE status='running') is the
      // last line of defense against a duplicate concurrent start; a
      // constraint violation here means one already exists, which is the
      // same closed outcome as losing the task-state CAS above.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'selected', 'triaging', 'control', 'triage_started', NULL, NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    const task = getTaskRow(db, taskId)
    if (!task) {
      throw new Error(`audited task ${taskId} vanished after starting triage`)
    }
    return { ok: true, runId, task }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export type FinalizeTriageRunSuccessArgs = {
  runId: string
  taskId: string
  decision: TriageDecision
  reasonCode: null
  rationale: string
  acceptanceCriteria: AuditedAcceptanceCriterion[]
  nextStepPrompt: string
}

export type FinalizeTriageRunBlockedArgs = {
  runId: string
  taskId: string
  reasonCode: TriageReasonCode
}

export type FinalizeTriageRunResult =
  | { ok: true; task: AuditedTaskRow }
  | { ok: false; reasonCode: 'task_not_found' | 'lock_contended' }

// Why: a run started against a task in `triaging` must find it still there —
// nothing else can legally move a `triaging` task except this finalize call
// (Phase 2 has no other writer of that state), but the CAS guard is kept
// anyway so a future concurrent writer fails closed instead of clobbering.
function finalizeTriageRunInternal(
  db: Database.Database,
  runId: string,
  taskId: string,
  toState: AuditedTaskState,
  nowMs: number,
  runUpdate: {
    status: 'succeeded' | 'blocked'
    decision: TriageDecision | null
    reasonCode: TriageReasonCode | null
    rationale: string | null
    acceptanceCriteriaJson: string | null
    nextStepPrompt: string | null
  },
  taskUpdate: {
    triageDecision: TriageDecision | null
    triageBlockedReasonCode: TriageReasonCode | null
    blockedReasonCode: TriageReasonCode | null
    preBlockState: AuditedTaskState | null
    blockedPhase: string | null
  }
): FinalizeTriageRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, taskId)
    if (!existing) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }
    if (existing.state !== 'triaging') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const runUpdateResult = db
      .prepare(
        `UPDATE audited_triage_runs
           SET status = ?, decision = ?, reason_code = ?, rationale = ?, acceptance_criteria_json = ?, next_step_prompt = ?, ended_at_ms = ?
         WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(
        runUpdate.status,
        runUpdate.decision,
        runUpdate.reasonCode,
        runUpdate.rationale,
        runUpdate.acceptanceCriteriaJson,
        runUpdate.nextStepPrompt,
        nowMs,
        runId,
        taskId
      )
    // Why (fail-closed): this run row must still be 'running' for this
    // finalize call to be the one authorized to move the task's state. If
    // changes() !== 1 — the run was already finalized by a concurrent
    // caller, the runId/taskId pair no longer matches a running row, or the
    // row never existed — the task-state UPDATE below must NEVER run: doing
    // so would transition the task based on an outcome that was not (or was
    // no longer) this call's to record.
    if (runUpdateResult.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const updateResult = db
      .prepare(
        `UPDATE audited_tasks
           SET state = ?,
               triage_decision = ?,
               triage_run_status = ?,
               triage_blocked_reason_code = ?,
               blocked_reason_code = ?,
               pre_block_state = ?,
               blocked_phase = ?,
               updated_at_ms = ?
         WHERE id = ? AND state = 'triaging'`
      )
      .run(
        toState,
        taskUpdate.triageDecision,
        runUpdate.status,
        taskUpdate.triageBlockedReasonCode,
        taskUpdate.blockedReasonCode,
        taskUpdate.preBlockState,
        taskUpdate.blockedPhase,
        nowMs,
        taskId
      )
    if (updateResult.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'triaging', ?, 'triage', ?, ?, NULL, ?)`
    ).run(
      taskId,
      toState,
      toState === 'blocked' ? 'triage_blocked' : `triage_${runUpdate.decision}`,
      runUpdate.reasonCode,
      nowMs
    )

    db.exec('COMMIT')
    const task = getTaskRow(db, taskId)
    if (!task) {
      throw new Error(`audited task ${taskId} vanished after finalizing triage`)
    }
    return { ok: true, task }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function finalizeTriageRunSucceeded(
  db: Database.Database,
  args: FinalizeTriageRunSuccessArgs,
  nowMs: number
): FinalizeTriageRunResult {
  const toState: AuditedTaskState = args.decision === 'plan' ? 'planning' : 'ready_to_implement'
  return finalizeTriageRunInternal(
    db,
    args.runId,
    args.taskId,
    toState,
    nowMs,
    {
      status: 'succeeded',
      decision: args.decision,
      reasonCode: null,
      rationale: args.rationale,
      acceptanceCriteriaJson: JSON.stringify(args.acceptanceCriteria),
      nextStepPrompt: args.nextStepPrompt
    },
    {
      triageDecision: args.decision,
      triageBlockedReasonCode: null,
      blockedReasonCode: null,
      preBlockState: null,
      blockedPhase: null
    }
  )
}

export function finalizeTriageRunBlocked(
  db: Database.Database,
  args: FinalizeTriageRunBlockedArgs,
  nowMs: number
): FinalizeTriageRunResult {
  return finalizeTriageRunInternal(
    db,
    args.runId,
    args.taskId,
    'blocked',
    nowMs,
    {
      status: 'blocked',
      decision: null,
      reasonCode: args.reasonCode,
      rationale: null,
      acceptanceCriteriaJson: null,
      nextStepPrompt: null
    },
    {
      triageDecision: null,
      triageBlockedReasonCode: args.reasonCode,
      blockedReasonCode: args.reasonCode,
      preBlockState: 'triaging',
      blockedPhase: 'triage'
    }
  )
}
