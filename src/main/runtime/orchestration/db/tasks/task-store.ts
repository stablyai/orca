import type Database from '../../../../sqlite/sync-database'
import type { TaskStatus, TaskRow } from '../../types'
import { ORCHESTRATION_TASK_STATUSES } from '../../../../../shared/orchestration-task-status'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../shared/orchestration-task-display'
import { generateId } from '../generated-id'
import type { TaskRuntimeLineageRow } from '../run-list-page'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { selectColumns, TASK_COLUMNS } from '../row-column-lists'

// ── Tasks ──

export function createTask(
  this: OrchestrationDb,
  task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    createdByPaneKey?: string
    createdByProcessIncarnation?: string
    createdByRunGeneration?: number
    runId?: string
  }
): TaskRow {
  const runId = task.runId
  if (!runId) {
    throw new Error('Run is required')
  }
  this.requireRun(runId)
  if (task.parentId) {
    const parent = this.getTask(task.parentId)
    if (!parent || parent.run_id !== runId) {
      throw new Error(`Parent task ${task.parentId} must belong to run ${runId}`)
    }
  }
  for (const depId of task.deps ?? []) {
    const dependency = this.getTask(depId)
    if (!dependency || dependency.run_id !== runId) {
      throw new Error(`Dependency task ${depId} must belong to run ${runId}`)
    }
  }
  const id = generateId('task')
  const depsJson = JSON.stringify(task.deps ?? [])
  const display = buildOrchestrationTaskDisplayMetadata({
    spec: task.spec,
    taskTitle: task.taskTitle,
    displayName: task.displayName
  })
  this.db
    .prepare(
      `INSERT INTO tasks (
         id, run_id, parent_id, created_by_terminal_handle, created_by_pane_key,
         created_by_process_incarnation, created_by_run_generation,
         task_title, display_name, spec, status, deps
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN EXISTS (
           SELECT 1
           FROM json_each(?) requested
           LEFT JOIN tasks dependency ON dependency.id = requested.value
           WHERE dependency.id IS NULL
              OR dependency.run_id <> ?
              OR dependency.status <> 'completed'
         ) THEN 'pending' ELSE 'ready' END,
         ?
       )`
    )
    .run(
      id,
      runId,
      task.parentId ?? null,
      task.createdByTerminalHandle ?? null,
      task.createdByPaneKey ?? null,
      task.createdByProcessIncarnation ?? null,
      task.createdByRunGeneration ?? null,
      display.taskTitle || null,
      display.displayName || null,
      task.spec,
      depsJson,
      runId,
      depsJson
    )
  return this.db.prepare(`SELECT ${TASK_COLUMN_LIST} FROM tasks WHERE id = ?`).get(id) as TaskRow
}

// Why wildcard-free: SyncDatabase refuses to cache any statement containing `*`, so a `SELECT *`
// here recompiles on every call — including the hot dispatch lookups and the coordinator poll.
const TASK_COLUMN_LIST = selectColumns(TASK_COLUMNS)

// Why: hoisted and wildcard-free so the per-publish lineage lookup hits the SyncDatabase statement cache.
const TASK_RUNTIME_LINEAGE_SQL = `SELECT ${selectColumns(TASK_COLUMNS, 't')},
         creator.id AS creator_dispatch_id,
         creator.run_id AS creator_dispatch_run_id,
         creator.assignee_pane_key AS creator_dispatch_pane_key,
         creator.process_incarnation AS creator_dispatch_process_incarnation
       FROM tasks t
       LEFT JOIN dispatch_contexts creator ON creator.rowid = (
         SELECT candidate.rowid
         FROM dispatch_contexts candidate
         WHERE candidate.assignee_handle = t.created_by_terminal_handle
           AND candidate.run_id = ?
           AND candidate.status IN ('pending', 'dispatched')
         ORDER BY candidate.rowid DESC
         LIMIT 1
       )
       WHERE t.id = ?`

// Why: return the active creator Dispatch proof with the Task read; runtime still owns pane/process currency.
export function getTask(this: OrchestrationDb, id: string): TaskRow | undefined
export function getTask(
  this: OrchestrationDb,
  id: string,
  dispatchRunId: string
): TaskRuntimeLineageRow | undefined
export function getTask(
  this: OrchestrationDb,
  id: string,
  dispatchRunId?: string
): TaskRow | TaskRuntimeLineageRow | undefined {
  if (dispatchRunId === undefined) {
    return this.db.prepare(`SELECT ${TASK_COLUMN_LIST} FROM tasks WHERE id = ?`).get(id) as
      | TaskRow
      | undefined
  }
  return this.db.prepare(TASK_RUNTIME_LINEAGE_SQL).get(dispatchRunId, id) as
    | TaskRuntimeLineageRow
    | undefined
}

export function listTasks(
  this: OrchestrationDb,
  filter?: { status?: TaskStatus; ready?: boolean; runId?: string }
): TaskRow[] {
  const runWhere = filter?.runId ? 'run_id = ? AND ' : ''
  const runParams: Database.BindValue[] = filter?.runId ? [filter.runId] : []
  if (filter?.ready) {
    return this.db
      .prepare(
        `SELECT ${TASK_COLUMN_LIST} FROM tasks WHERE ${runWhere}status = 'ready' ORDER BY created_at`
      )
      .all(...runParams) as TaskRow[]
  }
  if (filter?.status) {
    return this.db
      .prepare(
        `SELECT ${TASK_COLUMN_LIST} FROM tasks WHERE ${runWhere}status = ? ORDER BY created_at`
      )
      .all(...runParams, filter.status) as TaskRow[]
  }
  if (filter?.runId) {
    return this.db
      .prepare(`SELECT ${TASK_COLUMN_LIST} FROM tasks WHERE run_id = ? ORDER BY created_at`)
      .all(filter.runId) as TaskRow[]
  }
  return this.db
    .prepare(`SELECT ${TASK_COLUMN_LIST} FROM tasks ORDER BY created_at`)
    .all() as TaskRow[]
}

// Why: `orca serve stats` publishes live current-state counts, and task rows persist after they
// settle (only an explicit reset deletes them), so terminal statuses are excluded. `blocked` stays
// counted — it is resumable work (gate resolution / retry), not a settled outcome.
export function countTasks(this: OrchestrationDb): number {
  return Number(
    this.db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status NOT IN ('completed', 'failed')")
      .get()?.count ?? 0
  )
}

// Why: `orca serve stats` publishes the whole histogram, including the terminal statuses
// `countTasks` excludes — a settled-but-retained pile is the thing operators were counting by
// hand (#13047). One grouped scan, and every status is seeded so a status with no rows reads as
// 0 instead of vanishing from the contract.
export function countTasksByStatus(this: OrchestrationDb): Record<TaskStatus, number> {
  const counts = Object.fromEntries(
    ORCHESTRATION_TASK_STATUSES.map((status) => [status, 0])
  ) as Record<TaskStatus, number>
  const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all()
  for (const row of rows as { status: TaskStatus; count: number }[]) {
    if (row.status in counts) {
      counts[row.status] = Number(row.count)
    }
  }
  return counts
}

// Why: the correlated indexed lookup avoids materializing every retained Dispatch before filtering Tasks.
export function listTasksWithDispatch(
  this: OrchestrationDb,
  filter?: {
    status?: TaskStatus
    ready?: boolean
    runId?: string
  }
): (TaskRow & {
  assignee_handle: string | null
  dispatch_id: string | null
})[] {
  const whereClauses: string[] = []
  const params: Database.BindValue[] = []
  if (filter?.runId) {
    whereClauses.push('t.run_id = ?')
    params.push(filter.runId)
  }
  if (filter?.ready) {
    whereClauses.push("t.status = 'ready'")
  } else if (filter?.status) {
    whereClauses.push('t.status = ?')
    params.push(filter.status)
  }
  const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
  const sql = `
    SELECT
      t.*,
      d.assignee_handle AS assignee_handle,
      d.id              AS dispatch_id
    FROM tasks t
    LEFT JOIN dispatch_contexts d ON d.rowid = (
      SELECT candidate.rowid
      FROM dispatch_contexts candidate
      WHERE candidate.task_id = t.id
        AND candidate.status IN ('pending', 'dispatched')
      ORDER BY candidate.rowid DESC
      LIMIT 1
    )
    ${where}
    ORDER BY t.created_at
  `
  return this.db.prepare(sql).all(...params) as (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[]
}

// Why: runs in the status-update transaction, so a completed task never leaves its ready children unpromoted.
export function promoteReadyTasks(this: OrchestrationDb, completedTaskId: string): void {
  const candidates = this.db
    .prepare(`SELECT ${TASK_COLUMN_LIST} FROM tasks WHERE status = 'pending'`)
    .all() as TaskRow[]

  for (const task of candidates) {
    const deps: string[] = JSON.parse(task.deps)
    if (!deps.includes(completedTaskId)) {
      continue
    }

    const allDepsCompleted = deps.every((depId) => {
      const dep = this.getTask(depId)
      return dep?.status === 'completed'
    })
    if (allDepsCompleted) {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id: task.id,
        from: 'pending',
        to: 'ready'
      })
    }
  }
}

export type TaskStoreMethods = {
  createTask: typeof createTask
  getTask: typeof getTask
  listTasks: typeof listTasks
  countTasks: typeof countTasks
  countTasksByStatus: typeof countTasksByStatus
  listTasksWithDispatch: typeof listTasksWithDispatch
  promoteReadyTasks: typeof promoteReadyTasks
}

export function attachTaskStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTask,
    getTask,
    listTasks,
    countTasks,
    countTasksByStatus,
    listTasksWithDispatch,
    promoteReadyTasks
  })
}
