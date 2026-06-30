import type Database from '../sqlite/sync-database'
import { toJsonText } from './db-records'
import { generatePipelineId } from './db-identifiers'
import { appendPipelineLog } from './db-stage-log-operations'
import { getPipelineRun } from './db-read-queries'
import { markPipelineRecoveryReportReplacement } from './db-reservation-recovery-operations'
import type {
  PipelineRun,
  PipelineRunInput,
  PipelineRunStatus,
  PipelineRunStatusReason
} from '../../shared/pipelines-types'

const RUN_TERMINAL_STATUSES: PipelineRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]

export function createPipelineRun(
  db: Database.Database,
  input: PipelineRunInput,
  options: {
    automationRunId?: string | null
    replacesRunId?: string | null
    recoveryReportId?: string | null
  } = {}
): PipelineRun {
  const id = generatePipelineId('pipe_run')
  db.prepare(
    `INSERT INTO pipeline_runs (
      id, template_id, repo_id, source_branch, target_branch, task_source_json,
      max_concurrent, max_iterations, planner_agent_id, implementer_agent_id,
      reviewer_agent_id, merger_agent_id, verifier_json, execution_target_type,
      execution_target_id, automation_run_id, replaces_run_id, recovery_report_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.templateId,
    input.repoId,
    input.sourceBranch,
    input.targetBranch,
    JSON.stringify(input.taskSource),
    input.maxConcurrent,
    input.maxIterations ?? 1,
    input.plannerAgentId,
    input.implementerAgentId,
    input.reviewerAgentId ?? null,
    input.mergerAgentId,
    toJsonText(input.verifier),
    input.executionTargetType,
    input.executionTargetId ?? null,
    options.automationRunId ?? null,
    options.replacesRunId ?? null,
    options.recoveryReportId ?? null
  )
  if (options.recoveryReportId) {
    markPipelineRecoveryReportReplacement(db, options.recoveryReportId, id)
  }
  return getPipelineRunOrThrow(db, id)
}

export function updatePipelineRunStatus(
  db: Database.Database,
  id: string,
  status: PipelineRunStatus,
  error?: unknown
): PipelineRun | undefined {
  const existing = getPipelineRun(db, id)
  if (!existing) {
    return undefined
  }
  if (RUN_TERMINAL_STATUSES.includes(existing.status)) {
    return existing
  }
  const started = status !== 'pending' ? 1 : 0
  const completed = RUN_TERMINAL_STATUSES.includes(status) ? 1 : 0
  db.prepare(
    `UPDATE pipeline_runs
     SET status = ?, error_json = COALESCE(?, error_json), updated_at = datetime('now'),
         started_at = CASE WHEN ? THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
         completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END
     WHERE id = ?`
  ).run(status, toJsonText(error), started, completed, id)
  if (existing.status !== status) {
    appendPipelineLog(db, {
      runId: id,
      level: 'info',
      message: `Pipeline run status changed to ${status}`
    })
  }
  return getPipelineRun(db, id)
}

export function cancelPipelineRun(db: Database.Database, runId: string): PipelineRun {
  const existing = getPipelineRun(db, runId)
  if (existing && RUN_TERMINAL_STATUSES.includes(existing.status)) {
    return existing
  }
  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE pipeline_runs SET status = 'cancelled', updated_at = datetime('now'),
         completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?`
    ).run(runId)
    db.prepare(
      `UPDATE pipeline_iterations SET status = 'cancelled', updated_at = datetime('now'),
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`
    ).run(runId)
    db.prepare(
      `UPDATE pipeline_tasks SET status = 'cancelled', updated_at = datetime('now'),
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE run_id = ? AND status NOT IN ('verified', 'failed', 'cancelled', 'skipped', 'interrupted')`
    ).run(runId)
    db.prepare(
      `UPDATE pipeline_stages SET status = 'cancelled',
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'skipped', 'interrupted')`
    ).run(runId)
    appendPipelineLog(db, { runId, level: 'warn', message: 'Pipeline run cancelled' })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return getPipelineRunOrThrow(db, runId)
}

export function cancelPipelineRunWithReason(
  db: Database.Database,
  runId: string,
  reason: PipelineRunStatusReason
): PipelineRun {
  const existing = getPipelineRun(db, runId)
  if (existing && RUN_TERMINAL_STATUSES.includes(existing.status)) {
    return existing
  }
  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE pipeline_runs SET status = 'cancelled', status_reason = ?,
         updated_at = datetime('now'), completed_at = COALESCE(completed_at, datetime('now'))
       WHERE id = ?`
    ).run(reason, runId)
    db.prepare(
      `UPDATE pipeline_iterations SET status = 'cancelled', updated_at = datetime('now'),
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`
    ).run(runId)
    db.prepare(
      `UPDATE pipeline_tasks SET status = 'cancelled', updated_at = datetime('now'),
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE run_id = ? AND status NOT IN ('verified', 'failed', 'cancelled', 'skipped', 'interrupted')`
    ).run(runId)
    db.prepare(
      `UPDATE pipeline_stages SET status = 'cancelled',
         completed_at = COALESCE(completed_at, datetime('now'))
       WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'skipped', 'interrupted')`
    ).run(runId)
    appendPipelineLog(db, {
      runId,
      level: 'warn',
      message: `Pipeline run cancelled: ${reason}`
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return getPipelineRunOrThrow(db, runId)
}

function getPipelineRunOrThrow(db: Database.Database, id: string): PipelineRun {
  const run = getPipelineRun(db, id)
  if (!run) {
    throw new Error(`Pipeline run not found: ${id}`)
  }
  return run
}
