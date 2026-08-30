import { OrchestrationError } from '../../orchestration-error'
import type { TaskRow } from '../../types'
import {
  deriveWorkerTerminalListState,
  type WorkerDispatchListState,
  type WorkerTerminalListState,
  type WorkerTerminalResourceRow
} from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'

const MAX_TARGET_CONCURRENCY = 64

export type RunCapacitySnapshot = {
  runId: string
  targetConcurrency: number
  activeCount: number
  availableSlots: number
  launchableCount: number
  launchableTasks: TaskRow[]
  eligiblePendingTaskIds: string[]
  settledTerminalDebt: {
    dispatchId: string
    terminalState: WorkerTerminalListState
    retainedReason: string | null
  }[]
}

export function configureRunCapacity(
  this: OrchestrationDb,
  runId: string,
  targetConcurrency: number
): RunCapacitySnapshot {
  if (
    !Number.isInteger(targetConcurrency) ||
    targetConcurrency < 0 ||
    targetConcurrency > MAX_TARGET_CONCURRENCY
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      `Target concurrency must be an integer between 0 and ${MAX_TARGET_CONCURRENCY}.`
    )
  }
  const updated = this.db
    .prepare(
      "UPDATE runs SET target_concurrency = ?, updated_at = datetime('now') WHERE id = ? AND legacy = 0"
    )
    .run(targetConcurrency, runId)
  if (updated.changes !== 1) {
    throw new OrchestrationError('run_not_found', `Run ${runId} was not found or is inspect-only.`)
  }
  return this.getRunCapacity(runId)
}

export function setTaskCapacityEligibility(
  this: OrchestrationDb,
  taskId: string,
  eligible: boolean
): TaskRow {
  const updated = this.db
    .prepare('UPDATE tasks SET capacity_eligible = ? WHERE id = ?')
    .run(eligible ? 1 : 0, taskId)
  if (updated.changes !== 1) {
    throw new OrchestrationError('task_not_found', `Task ${taskId} was not found.`)
  }
  return this.getTask(taskId) as TaskRow
}

export function assertRunCapacityAvailable(
  this: OrchestrationDb,
  taskId: string,
  requireEnrollment = false
): void {
  const task = this.getTask(taskId)
  if (!task) {
    throw new OrchestrationError('task_not_found', `Task ${taskId} was not found.`)
  }
  if (requireEnrollment && task.capacity_eligible !== 1) {
    throw new OrchestrationError(
      'task_not_startable',
      `Task ${task.id} is not enrolled in its Run capacity pool.`
    )
  }
  const run = this.getRunRaw(task.run_id)
  if (!run || run.legacy === 1) {
    if (!requireEnrollment) {
      return
    }
    throw new OrchestrationError(
      'capacity_not_configured',
      `Run ${task.run_id} cannot claim a capacity slot.`
    )
  }
  if (run.target_concurrency < 1) {
    if (!requireEnrollment) {
      return
    }
    throw new OrchestrationError(
      'capacity_not_configured',
      `Run ${run.id} has no target concurrency; configure it before claiming a capacity slot.`
    )
  }
  const row = this.db
    .prepare(
      `SELECT COUNT(*) AS active_count
       FROM dispatch_contexts
       WHERE run_id = ? AND status IN ('pending', 'dispatched')`
    )
    .get(run.id) as { active_count: number }
  if (row.active_count >= run.target_concurrency) {
    throw new OrchestrationError(
      'capacity_full',
      `Run ${run.id} already has ${row.active_count} active lanes at target concurrency ${run.target_concurrency}.`,
      { runId: run.id, activeCount: row.active_count, targetConcurrency: run.target_concurrency }
    )
  }
}

export function assertRunCapacitySlot(this: OrchestrationDb, taskId: string): void {
  this.assertRunCapacityAvailable(taskId, true)
}

export function getRunCapacity(this: OrchestrationDb, runId: string): RunCapacitySnapshot {
  const run = this.getRunRaw(runId)
  if (!run || run.legacy === 1) {
    throw new OrchestrationError('run_not_found', `Run ${runId} was not found or is inspect-only.`)
  }
  const active = this.db
    .prepare(
      `SELECT COUNT(*) AS active_count
       FROM dispatch_contexts
       WHERE run_id = ? AND status IN ('pending', 'dispatched')`
    )
    .get(runId) as { active_count: number }
  const availableSlots = Math.max(0, run.target_concurrency - active.active_count)
  const launchableTasks = this.db
    .prepare(
      `SELECT tasks.* FROM tasks
       WHERE run_id = ? AND capacity_eligible = 1 AND status = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM dispatch_contexts
           WHERE dispatch_contexts.task_id = tasks.id
             AND dispatch_contexts.status IN ('pending', 'dispatched')
         )
         AND NOT EXISTS (
           SELECT 1 FROM decision_gates
           WHERE decision_gates.task_id = tasks.id AND decision_gates.status = 'pending'
         )
       ORDER BY created_at, rowid
       LIMIT ?`
    )
    .all(runId, availableSlots) as TaskRow[]
  const eligiblePendingTaskIds = (
    this.db
      .prepare(
        `SELECT id FROM tasks
         WHERE run_id = ? AND capacity_eligible = 1 AND status IN ('pending', 'blocked')
         ORDER BY created_at, rowid`
      )
      .all(runId) as { id: string }[]
  ).map((task) => task.id)
  const debtRows = this.db
    .prepare(
      `SELECT r.*, d.id AS dispatch_id,
              COALESCE(w.state, 'unsupervised') AS worker_state,
              COALESCE(w.agent_terminal_handle, d.assignee_handle) AS agent_terminal_handle
         FROM dispatch_contexts d
         JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
        WHERE d.run_id = ?
          AND d.status IN ('completed', 'failed', 'circuit_broken')
          AND r.release_state <> 'released'
        ORDER BY COALESCE(w.created_at, d.created_at), d.rowid`
    )
    .all(runId) as (WorkerTerminalResourceRow & {
    dispatch_id: string
    worker_state: WorkerDispatchListState
    agent_terminal_handle: string | null
  })[]
  const settledTerminalDebt = debtRows.flatMap((row) => {
    const terminalState = deriveWorkerTerminalListState({
      workerState: row.worker_state,
      agentTerminalHandle: row.agent_terminal_handle,
      resource: row
    })
    return terminalState && terminalState !== 'released'
      ? [
          {
            dispatchId: row.dispatch_id,
            terminalState,
            retainedReason: row.retained_reason
          }
        ]
      : []
  })
  return {
    runId,
    targetConcurrency: run.target_concurrency,
    activeCount: active.active_count,
    availableSlots,
    launchableCount: launchableTasks.length,
    launchableTasks,
    eligiblePendingTaskIds,
    settledTerminalDebt
  }
}

export type RunCapacityStoreMethods = {
  configureRunCapacity: typeof configureRunCapacity
  setTaskCapacityEligibility: typeof setTaskCapacityEligibility
  assertRunCapacityAvailable: typeof assertRunCapacityAvailable
  assertRunCapacitySlot: typeof assertRunCapacitySlot
  getRunCapacity: typeof getRunCapacity
}

export function attachRunCapacityStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    configureRunCapacity,
    setTaskCapacityEligibility,
    assertRunCapacityAvailable,
    assertRunCapacitySlot,
    getRunCapacity
  })
}
