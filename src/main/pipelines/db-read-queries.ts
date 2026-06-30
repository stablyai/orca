import type Database from '../sqlite/sync-database'
import {
  type PipelineDynamicContextResultRecord,
  type PipelineIterationRecord,
  type PipelineLogRecord,
  type PipelineRunRecord,
  type PipelineStageRecord,
  type PipelineTaskRecord,
  toPipelineDynamicContextResult,
  toPipelineIteration,
  toPipelineLogEntry,
  toPipelineRun,
  toPipelineStage,
  toPipelineTask
} from './db-records'
import type {
  PipelineDynamicContextResult,
  PipelineIteration,
  PipelineLogEntry,
  PipelineRun,
  PipelineRunDetail,
  PipelineRunStatus,
  PipelineStage,
  PipelineTask
} from '../../shared/pipelines-types'

export function listPipelineRuns(
  db: Database.Database,
  filter: { repoId?: string; status?: PipelineRunStatus; limit?: number } = {}
): PipelineRun[] {
  const clauses: string[] = []
  const params: Database.BindValue[] = []
  if (filter.repoId) {
    clauses.push('repo_id = ?')
    params.push(filter.repoId)
  }
  if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(filter.limit ?? 50)
  return db
    .prepare(`SELECT * FROM pipeline_runs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)
    .map((row) => toPipelineRun(row as PipelineRunRecord))
}

export function getPipelineRun(db: Database.Database, id: string): PipelineRun | undefined {
  const row = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as
    | PipelineRunRecord
    | undefined
  return row ? toPipelineRun(row) : undefined
}

export function getPipelineRunDetail(
  db: Database.Database,
  runId: string
): PipelineRunDetail | undefined {
  const run = getPipelineRun(db, runId)
  if (!run) {
    return undefined
  }
  return {
    run,
    iterations: listPipelineIterations(db, runId),
    tasks: listPipelineTasks(db, runId),
    stages: listPipelineStages(db, runId),
    logs: listPipelineLogs(db, { runId }),
    dynamicContextResults: listPipelineDynamicContextResults(db, runId)
  }
}

export function getPipelineIteration(
  db: Database.Database,
  id: string
): PipelineIteration | undefined {
  const row = db.prepare('SELECT * FROM pipeline_iterations WHERE id = ?').get(id) as
    | PipelineIterationRecord
    | undefined
  return row ? toPipelineIteration(row) : undefined
}

export function getPipelineTask(db: Database.Database, id: string): PipelineTask | undefined {
  const row = db.prepare('SELECT * FROM pipeline_tasks WHERE id = ?').get(id) as
    | PipelineTaskRecord
    | undefined
  return row ? toPipelineTask(row) : undefined
}

export function getPipelineStage(db: Database.Database, id: string): PipelineStage | undefined {
  const row = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(id) as
    | PipelineStageRecord
    | undefined
  return row ? toPipelineStage(row) : undefined
}

export function listPipelineLogs(
  db: Database.Database,
  filter: { runId: string; stageId?: string; taskId?: string; limit?: number }
): PipelineLogEntry[] {
  const clauses = ['run_id = ?']
  const params: Database.BindValue[] = [filter.runId]
  if (filter.stageId) {
    clauses.push('stage_id = ?')
    params.push(filter.stageId)
  }
  if (filter.taskId) {
    clauses.push('task_id = ?')
    params.push(filter.taskId)
  }
  params.push(filter.limit ?? 100)
  return db
    .prepare(
      `SELECT * FROM pipeline_logs WHERE ${clauses.join(' AND ')} ORDER BY created_at LIMIT ?`
    )
    .all(...params)
    .map((row) => toPipelineLogEntry(row as PipelineLogRecord))
}

export function listPipelineDynamicContextResults(
  db: Database.Database,
  runId: string
): PipelineDynamicContextResult[] {
  return db
    .prepare('SELECT * FROM pipeline_dynamic_context_results WHERE run_id = ? ORDER BY created_at')
    .all(runId)
    .map((row) => toPipelineDynamicContextResult(row as PipelineDynamicContextResultRecord))
}

function listPipelineIterations(db: Database.Database, runId: string): PipelineIteration[] {
  return db
    .prepare('SELECT * FROM pipeline_iterations WHERE run_id = ? ORDER BY iteration_number')
    .all(runId)
    .map((row) => toPipelineIteration(row as PipelineIterationRecord))
}

function listPipelineTasks(db: Database.Database, runId: string): PipelineTask[] {
  return db
    .prepare('SELECT * FROM pipeline_tasks WHERE run_id = ? ORDER BY created_at')
    .all(runId)
    .map((row) => toPipelineTask(row as PipelineTaskRecord))
}

function listPipelineStages(db: Database.Database, runId: string): PipelineStage[] {
  return db
    .prepare('SELECT * FROM pipeline_stages WHERE run_id = ? ORDER BY started_at, id')
    .all(runId)
    .map((row) => toPipelineStage(row as PipelineStageRecord))
}
