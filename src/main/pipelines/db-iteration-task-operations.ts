import type Database from '../sqlite/sync-database'
import { toJsonText } from './db-records'
import { generatePipelineId } from './db-identifiers'
import type {
  CreatePipelineIterationInput,
  CreatePipelineTaskInput,
  UpdatePipelineIterationPlannerResultInput,
  UpdatePipelineTaskCommitShasInput,
  UpdatePipelineTaskDispatchLinkInput,
  UpdatePipelineTaskIssueClosureInput
} from './db-operation-inputs'
import { getPipelineIteration, getPipelineTask } from './db-read-queries'
import type {
  PipelineIteration,
  PipelineIterationStatus,
  PipelineTask,
  PipelineTaskStatus
} from '../../shared/pipelines-types'

const ITERATION_TERMINAL_STATUSES: PipelineIterationStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]
const TASK_TERMINAL_STATUSES: PipelineTaskStatus[] = [
  'verified',
  'failed',
  'cancelled',
  'skipped',
  'interrupted'
]

export function createPipelineIteration(
  db: Database.Database,
  input: CreatePipelineIterationInput
): PipelineIteration {
  const id = generatePipelineId('pipe_iter')
  db.prepare(
    `INSERT INTO pipeline_iterations (
      id, run_id, iteration_number, status, planner_terminal_id,
      planner_worktree_id, coordinator_run_id, planner_output_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.runId,
    input.iterationNumber,
    input.status ?? 'pending',
    input.plannerTerminalId ?? null,
    input.plannerWorktreeId ?? null,
    input.coordinatorRunId ?? null,
    toJsonText(input.plannerOutput)
  )
  db.prepare(
    `UPDATE pipeline_runs SET current_iteration = MAX(current_iteration, ?),
     updated_at = datetime('now') WHERE id = ?`
  ).run(input.iterationNumber, input.runId)
  return getPipelineIterationOrThrow(db, id)
}

export function updatePipelineIterationStatus(
  db: Database.Database,
  id: string,
  status: PipelineIterationStatus,
  error?: unknown
): PipelineIteration | undefined {
  const existing = getPipelineIteration(db, id)
  if (existing && ITERATION_TERMINAL_STATUSES.includes(existing.status)) {
    return existing
  }
  const active = status !== 'pending' ? 1 : 0
  const completed = ITERATION_TERMINAL_STATUSES.includes(status) ? 1 : 0
  db.prepare(
    `UPDATE pipeline_iterations
     SET status = ?, error_json = COALESCE(?, error_json), updated_at = datetime('now'),
         started_at = CASE WHEN ? THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
         completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END
     WHERE id = ?`
  ).run(status, toJsonText(error), active, completed, id)
  return getPipelineIteration(db, id)
}

export function updatePipelineIterationPlannerResult(
  db: Database.Database,
  id: string,
  input: UpdatePipelineIterationPlannerResultInput
): PipelineIteration | undefined {
  db.prepare(
    `UPDATE pipeline_iterations
     SET planner_terminal_id = COALESCE(?, planner_terminal_id),
         planner_worktree_id = COALESCE(?, planner_worktree_id),
         planner_output_json = COALESCE(?, planner_output_json),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    input.plannerTerminalId ?? null,
    input.plannerWorktreeId ?? null,
    toJsonText(input.plannerOutput),
    id
  )
  return getPipelineIteration(db, id)
}

export function createPipelineTask(
  db: Database.Database,
  input: CreatePipelineTaskInput
): PipelineTask {
  const id = generatePipelineId('pipe_task')
  db.prepare(
    `INSERT INTO pipeline_tasks (
      id, run_id, iteration_id, source_type, source_id, title, branch,
      status, blocked_by_json, orchestration_task_id, worktree_id,
      terminal_ids_json, commit_shas_json, result_json, issue_closure_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.runId,
    input.iterationId,
    input.sourceType,
    input.sourceId,
    input.title,
    input.branch,
    input.status ?? 'planned',
    JSON.stringify(input.blockedBy ?? []),
    input.orchestrationTaskId ?? null,
    input.worktreeId ?? null,
    JSON.stringify(input.terminalIds ?? []),
    JSON.stringify(input.commitShas ?? []),
    toJsonText(input.result),
    toJsonText(input.issueClosure)
  )
  return getPipelineTaskOrThrow(db, id)
}

export function updatePipelineTaskStatus(
  db: Database.Database,
  id: string,
  status: PipelineTaskStatus,
  error?: unknown
): PipelineTask | undefined {
  const existing = getPipelineTask(db, id)
  if (existing && TASK_TERMINAL_STATUSES.includes(existing.status)) {
    return existing
  }
  const active = status !== 'planned' ? 1 : 0
  const completed = TASK_TERMINAL_STATUSES.includes(status) ? 1 : 0
  db.prepare(
    `UPDATE pipeline_tasks
     SET status = ?, error_json = COALESCE(?, error_json), updated_at = datetime('now'),
         started_at = CASE WHEN ? THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
         completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END
     WHERE id = ?`
  ).run(status, toJsonText(error), active, completed, id)
  return getPipelineTask(db, id)
}

export function updatePipelineTaskDispatchLink(
  db: Database.Database,
  id: string,
  input: UpdatePipelineTaskDispatchLinkInput
): PipelineTask | undefined {
  db.prepare(
    `UPDATE pipeline_tasks
     SET orchestration_task_id = ?, worktree_id = ?, status = 'worktree_created',
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(input.orchestrationTaskId, input.worktreeId, id)
  return getPipelineTask(db, id)
}

export function updatePipelineTaskCommitShas(
  db: Database.Database,
  id: string,
  input: UpdatePipelineTaskCommitShasInput
): PipelineTask | undefined {
  db.prepare(
    `UPDATE pipeline_tasks
     SET commit_shas_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(input.commitShas), id)
  return getPipelineTask(db, id)
}

export function updatePipelineTaskIssueClosure(
  db: Database.Database,
  id: string,
  input: UpdatePipelineTaskIssueClosureInput
): PipelineTask | undefined {
  db.prepare(
    `UPDATE pipeline_tasks
     SET issue_closure_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(toJsonText(input.issueClosure), id)
  return getPipelineTask(db, id)
}

function getPipelineIterationOrThrow(db: Database.Database, id: string): PipelineIteration {
  const iteration = getPipelineIteration(db, id)
  if (!iteration) {
    throw new Error(`Pipeline iteration not found: ${id}`)
  }
  return iteration
}

function getPipelineTaskOrThrow(db: Database.Database, id: string): PipelineTask {
  const task = getPipelineTask(db, id)
  if (!task) {
    throw new Error(`Pipeline task not found: ${id}`)
  }
  return task
}
