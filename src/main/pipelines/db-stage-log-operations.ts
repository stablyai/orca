import type Database from '../sqlite/sync-database'
import { type PipelineLogRecord, toJsonText, toPipelineLogEntry } from './db-records'
import { generatePipelineId } from './db-identifiers'
import type {
  AppendPipelineLogInput,
  CreatePipelineStageInput,
  RecordPipelineDynamicContextResultInput,
  UpdatePipelineStageExecutionRefsInput,
  UpdatePipelineStageOptions
} from './db-operation-inputs'
import { getPipelineStage, listPipelineDynamicContextResults } from './db-read-queries'
import type {
  PipelineDynamicContextResult,
  PipelineLogEntry,
  PipelineStage,
  PipelineStageStatus
} from '../../shared/pipelines-types'

const STAGE_TERMINAL_STATUSES: PipelineStageStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'interrupted'
]

export function createPipelineStage(
  db: Database.Database,
  input: CreatePipelineStageInput
): PipelineStage {
  const id = generatePipelineId('pipe_stage')
  const status = input.status ?? 'pending'
  db.prepare(
    `INSERT INTO pipeline_stages (
      id, run_id, iteration_id, task_id, stage, status, worktree_id,
      terminal_id, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END,
      CASE WHEN ? THEN datetime('now') END)`
  ).run(
    id,
    input.runId,
    input.iterationId ?? null,
    input.taskId ?? null,
    input.stage,
    status,
    input.worktreeId ?? null,
    input.terminalId ?? null,
    status === 'running' ? 1 : 0,
    STAGE_TERMINAL_STATUSES.includes(status) ? 1 : 0
  )
  return getPipelineStageOrThrow(db, id)
}

export function updatePipelineStageStatus(
  db: Database.Database,
  id: string,
  status: PipelineStageStatus,
  options: UpdatePipelineStageOptions = {}
): PipelineStage | undefined {
  const existing = getPipelineStage(db, id)
  if (existing && STAGE_TERMINAL_STATUSES.includes(existing.status)) {
    return existing
  }
  const running = status === 'running' ? 1 : 0
  const completed = STAGE_TERMINAL_STATUSES.includes(status) ? 1 : 0
  db.prepare(
    `UPDATE pipeline_stages
     SET status = ?, output_snapshot = COALESCE(?, output_snapshot),
         error_json = COALESCE(?, error_json),
         started_at = CASE WHEN ? THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
         completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END
     WHERE id = ?`
  ).run(status, options.outputSnapshot ?? null, toJsonText(options.error), running, completed, id)
  return getPipelineStage(db, id)
}

export function updatePipelineStageExecutionRefs(
  db: Database.Database,
  id: string,
  input: UpdatePipelineStageExecutionRefsInput
): PipelineStage | undefined {
  db.prepare(
    `UPDATE pipeline_stages
     SET terminal_id = COALESCE(?, terminal_id),
         worktree_id = COALESCE(?, worktree_id)
     WHERE id = ?`
  ).run(input.terminalId ?? null, input.worktreeId ?? null, id)
  return getPipelineStage(db, id)
}

export function appendPipelineLog(
  db: Database.Database,
  input: AppendPipelineLogInput
): PipelineLogEntry {
  const id = generatePipelineId('pipe_log')
  db.prepare(
    `INSERT INTO pipeline_logs (
      id, run_id, iteration_id, task_id, stage_id, level, message, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.runId,
    input.iterationId ?? null,
    input.taskId ?? null,
    input.stageId ?? null,
    input.level ?? 'info',
    input.message,
    toJsonText(input.payload)
  )
  const row = db.prepare('SELECT * FROM pipeline_logs WHERE id = ?').get(id) as PipelineLogRecord
  return toPipelineLogEntry(row)
}

export function recordPipelineDynamicContextResult(
  db: Database.Database,
  input: RecordPipelineDynamicContextResultInput
): PipelineDynamicContextResult {
  const id = generatePipelineId('pipe_ctx')
  db.prepare(
    `INSERT INTO pipeline_dynamic_context_results (
      id, run_id, stage_id, template_id, command, cwd, exit_code, timed_out,
      stdout, stderr, stdout_truncated, stderr_truncated, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    id,
    input.runId,
    input.stageId ?? null,
    input.templateId,
    input.command,
    input.cwd,
    input.exitCode,
    input.timedOut ? 1 : 0,
    input.stdout,
    input.stderr,
    input.stdoutTruncated ? 1 : 0,
    input.stderrTruncated ? 1 : 0
  )
  return listPipelineDynamicContextResults(db, input.runId).find((result) => result.id === id)!
}

function getPipelineStageOrThrow(db: Database.Database, id: string): PipelineStage {
  const stage = getPipelineStage(db, id)
  if (!stage) {
    throw new Error(`Pipeline stage not found: ${id}`)
  }
  return stage
}
