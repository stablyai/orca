import { OrchestrationError } from '../../orchestration-error'
import type { DispatchContextRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'

export function recordWorkerProgress(
  this: OrchestrationDb,
  params: { dispatchId: string; note: string; at?: string }
): DispatchContextRow {
  const at = params.at ?? new Date().toISOString()
  const updated = this.db
    .prepare(
      `UPDATE dispatch_contexts
          SET progress_note = ?, progress_updated_at = ?
        WHERE id = ? AND status = 'dispatched'`
    )
    .run(params.note, at, params.dispatchId)
  if (updated.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${params.dispatchId} is not active.`
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
  Object.assign(ctor.prototype, { recordWorkerProgress })
}
