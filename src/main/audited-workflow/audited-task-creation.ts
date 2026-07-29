// Atomic task creation: the initial row insert and its task_created
// transition are written in one SQLite transaction, so a failure between
// the two (e.g. a constraint violation, a crash, an injected fault) can
// never leave a task without its initial transition, or a transition
// pointing at a task that doesn't exist.
import { randomBytes } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import type { AuditedTaskSource, RiskLevel } from '../../shared/audited-workflow-types'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'

export type AuditedTaskSpec = {
  title: string
  description: string
}

export type CreateAuditedTaskInput = {
  repoId: string
  sourceRepoPath: string
  baseCommit: string
  hostId: string
  wslDistro?: string | null
  title: string
  spec: AuditedTaskSpec
  source: AuditedTaskSource
  roadmapEntryId?: string | null
  risk: RiskLevel
}

function generateTaskId(): string {
  return `audited_${randomBytes(8).toString('hex')}`
}

function getTaskRow(db: Database.Database, taskId: string): AuditedTaskRow | null {
  const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToTask(row) : null
}

export function createAuditedTaskAtomically(
  db: Database.Database,
  input: CreateAuditedTaskInput,
  nowMs: number
): AuditedTaskRow {
  const id = generateTaskId()
  const specJson = JSON.stringify({ title: input.title, description: input.spec.description })

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO audited_tasks (
        id, repo_id, source_repo_path, base_commit, host_id, wsl_distro,
        title, spec_json, source, roadmap_entry_id, risk, state,
        plan_round, fix_round, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'selected', 0, 0, ?, ?)`
    ).run(
      id,
      input.repoId,
      input.sourceRepoPath,
      input.baseCommit,
      input.hostId,
      input.wslDistro ?? null,
      input.title,
      specJson,
      input.source,
      input.roadmapEntryId ?? null,
      input.risk,
      nowMs,
      nowMs
    )

    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, NULL, 'selected', 'human', 'task_created', NULL, NULL, ?)`
    ).run(id, nowMs)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const created = getTaskRow(db, id)
  if (!created) {
    throw new Error(`audited task ${id} was not persisted`)
  }
  return created
}
