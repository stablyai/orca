import type { RunParentDispatch, RunRow } from '../../types'
import { generateId } from '../generated-id'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    /** The attested active worker Dispatch that created this sub-Run, if any. */
    parentDispatch?: RunParentDispatch
  }
): RunRow {
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Re-check inside the write transaction so a completed/revoked Dispatch is never
    // recorded as the origin of a Run after its lifecycle authority has ended.
    const parentDispatchId = validateRunParentDispatch.call(this, params.parentDispatch)
    this.unbindOtherRunsForPane(params.coordinatorPaneKey)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key,
           parent_dispatch_id, consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 0)`
      )
      .run(
        id,
        params.objective,
        params.coordinatorHandle,
        params.coordinatorPaneKey,
        parentDispatchId
      )
    this.rememberRunCoordinatorHandle(id, params.coordinatorHandle)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

function validateRunParentDispatch(
  this: OrchestrationDb,
  parent: RunParentDispatch | undefined
): string | null {
  if (!parent) {
    return null
  }
  if (parent.source === 'local') {
    const dispatch = this.getDispatchContextById(parent.dispatchId)
    return dispatch &&
      ['pending', 'dispatched'].includes(dispatch.status) &&
      !dispatch.capability_revoked_at &&
      dispatch.assignee_pane_key &&
      isEquivalentPaneKey(dispatch.assignee_pane_key, parent.paneKey) &&
      dispatch.process_incarnation === parent.processIncarnation
      ? dispatch.id
      : null
  }
  const attachment = this.getRemoteDispatchAttachment(parent.dispatchId)
  return attachment &&
    ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'].includes(attachment.state) &&
    attachment.pane_key &&
    isEquivalentPaneKey(attachment.pane_key, parent.paneKey) &&
    attachment.process_incarnation === parent.processIncarnation
    ? attachment.dispatch_id
    : null
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
