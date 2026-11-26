import { ORCHESTRATION_PROGRESS_NOTE_MAX } from '../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { OrchestrationError } from '../../orchestration-error'
import type { DispatchContextRow, TaskRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'

export type RecordedWorkerProgress = {
  task: TaskRow
  dispatch: DispatchContextRow | null
  dispatchId: string | null
  note: string
  updatedAt: string
}

export function recordWorkerProgress(
  this: OrchestrationDb,
  params: {
    taskId?: string
    dispatchId?: string
    note: string
    at?: string
  }
): RecordedWorkerProgress {
  const note = params.note.trim()
  if (!note) {
    throw new OrchestrationError('invalid_argument', '--note cannot be empty.')
  }
  if (note.length > ORCHESTRATION_PROGRESS_NOTE_MAX) {
    throw new OrchestrationError(
      'invalid_argument',
      `Progress note must be at most ${ORCHESTRATION_PROGRESS_NOTE_MAX} characters.`
    )
  }

  let targetDispatch: DispatchContextRow | null = null
  if (params.dispatchId) {
    const existing = this.getDispatchContextById(params.dispatchId)
    if (!existing) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${params.dispatchId} was not found.`
      )
    }
    if (existing.status !== 'dispatched') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is ${existing.status}; passive task-update --note applies only while a worker Dispatch is active. (send = always wakes the recipient; task-update --note = passive, never wakes.)`
      )
    }
    if (params.taskId && params.taskId !== existing.task_id) {
      throw new OrchestrationError(
        'sender_not_assignee',
        `Dispatch ${params.dispatchId} belongs to task ${existing.task_id}, not ${params.taskId}.`
      )
    }
    targetDispatch = existing
  }

  const resolvedTaskId = params.taskId ?? targetDispatch?.task_id
  if (!resolvedTaskId) {
    throw new OrchestrationError('invalid_argument', 'Missing --id or active worker Dispatch.')
  }
  const existingTask = this.getTask(resolvedTaskId)
  if (!existingTask) {
    throw new OrchestrationError('task_not_found', `Task ${resolvedTaskId} was not found.`)
  }

  if (!targetDispatch) {
    const activeRow = this.db
      .prepare(
        `SELECT id FROM dispatch_contexts
         WHERE task_id = ? AND status = 'dispatched'
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(resolvedTaskId)
    if (activeRow && typeof activeRow.id === 'string') {
      targetDispatch = this.getDispatchContextById(activeRow.id) ?? null
    }
  }

  const at = params.at ?? new Date().toISOString()
  if (targetDispatch) {
    const updated = this.db
      .prepare(
        `UPDATE dispatch_contexts
            SET progress_note = ?, progress_updated_at = ?
          WHERE id = ? AND status = 'dispatched'`
      )
      .run(note, at, targetDispatch.id)
    if (updated.changes !== 1 && params.dispatchId) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${targetDispatch.id} is no longer active.`
      )
    }
  }

  this.db
    .prepare('UPDATE tasks SET progress_note = ?, progress_updated_at = ? WHERE id = ?')
    .run(note, at, resolvedTaskId)

  const reloadedTask = this.getTask(resolvedTaskId)
  if (!reloadedTask) {
    throw new OrchestrationError('task_not_found', `Task ${resolvedTaskId} was not found.`)
  }
  const reloadedDispatch = targetDispatch
    ? (this.getDispatchContextById(targetDispatch.id) ?? null)
    : null
  if (reloadedDispatch) {
    this.workerDockSources?.changedDispatchProgress(reloadedDispatch.id)
  }
  return {
    task: reloadedTask,
    dispatch: reloadedDispatch,
    dispatchId: reloadedDispatch?.id ?? null,
    note,
    updatedAt: at
  }
}

export type DispatchProgressMethods = {
  recordWorkerProgress: typeof recordWorkerProgress
}

export function attachDispatchProgress(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordWorkerProgress
  })
}
