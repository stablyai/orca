import { ORCHESTRATION_PROGRESS_NOTE_MAX } from '../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { OrchestrationError } from '../../orchestration-error'
import type { DispatchContextRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'

export function recordWorkerProgress(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    note: string
    at?: string
  }
): DispatchContextRow {
  const note = params.note.trim()
  if (!note) {
    throw new OrchestrationError('invalid_argument', 'Missing --note')
  }
  if (note.length > ORCHESTRATION_PROGRESS_NOTE_MAX) {
    throw new OrchestrationError(
      'invalid_argument',
      `Progress note must be at most ${ORCHESTRATION_PROGRESS_NOTE_MAX} characters.`
    )
  }
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
      `Dispatch ${params.dispatchId} is ${existing.status}; passive progress notes apply only while a worker Dispatch is active. Use orca orchestration send when a recipient must be woken.`
    )
  }
  const at = params.at ?? new Date().toISOString()
  const updated = this.db
    .prepare(
      `UPDATE dispatch_contexts
          SET progress_note = ?, progress_updated_at = ?
        WHERE id = ? AND status = 'dispatched'`
    )
    .run(note, at, params.dispatchId)
  if (updated.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${params.dispatchId} is no longer active.`
    )
  }
  this.workerDockSources?.changedDispatchProgress(params.dispatchId)
  const reloaded = this.getDispatchContextById(params.dispatchId)
  if (!reloaded) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${params.dispatchId} was not found.`
    )
  }
  return reloaded
}

export type DispatchProgressMethods = {
  recordWorkerProgress: typeof recordWorkerProgress
}

export function attachDispatchProgress(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordWorkerProgress
  })
}
