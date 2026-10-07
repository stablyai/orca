import type { OrchestrationDb } from '../orchestration-db'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction
} from '../lifecycle-transition'

export type FederatedDispatchObservationFence = {
  dispatch_id: string
  remote_runtime_epoch: string | null
  remote_worktree_id: string | null
  remote_terminal_handle: string | null
  dispatch_status: string
  task_status: string
  worker_runtime_epoch: string | null
  worker_state: string
  worker_stage: string
  worker_worktree_id: string | null
  worker_terminal_handle: string | null
  worker_setup_state: string
  worker_effects: string
  worker_residual_resources: string
  worker_last_error: string | null
}

const OBSERVATION_FENCE_SQL = `SELECT fd.dispatch_id, fd.remote_runtime_epoch, fd.remote_worktree_id,
              fd.remote_terminal_handle, dc.status AS dispatch_status,
              t.status AS task_status, wd.runtime_epoch AS worker_runtime_epoch,
              wd.state AS worker_state, wd.stage AS worker_stage,
              wd.worktree_id AS worker_worktree_id,
              wd.agent_terminal_handle AS worker_terminal_handle,
              wd.setup_state AS worker_setup_state, wd.effects AS worker_effects,
              wd.residual_resources AS worker_residual_resources,
              wd.last_error AS worker_last_error
       FROM federated_dispatches fd
       INNER JOIN dispatch_contexts dc ON dc.id = fd.dispatch_id
       INNER JOIN tasks t ON t.id = dc.task_id
       INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
       WHERE fd.dispatch_id`

export function captureFederatedDispatchObservationFence(
  this: OrchestrationDb,
  dispatchId: string
): FederatedDispatchObservationFence | undefined {
  return this.db.prepare(`${OBSERVATION_FENCE_SQL} = ?`).get(dispatchId) as
    | FederatedDispatchObservationFence
    | undefined
}

/** One statement per host group; capturing a page's fences one row at a time was an N+1. */
export function captureFederatedDispatchObservationFences(
  this: OrchestrationDb,
  dispatchIds: readonly string[]
): Map<string, FederatedDispatchObservationFence> {
  if (dispatchIds.length === 0) {
    return new Map()
  }
  const rows = this.db
    .prepare(`${OBSERVATION_FENCE_SQL} IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...dispatchIds])) as FederatedDispatchObservationFence[]
  return new Map(rows.map((row) => [row.dispatch_id, row]))
}

export function projectFederatedDispatchObservation(
  this: OrchestrationDb,
  fence: FederatedDispatchObservationFence,
  projection: () => void
): boolean {
  const transaction = beginLifecycleWriteTransaction(this.db, 'federated_dispatch_observation')
  try {
    const current = this.captureFederatedDispatchObservationFence(fence.dispatch_id)
    if (!current || !observationFenceMatches(current, fence)) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return false
    }
    projection()
    commitLifecycleWriteTransaction(this.db, transaction)
    return true
  } catch (error) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw error
  }
}

function observationFenceMatches(
  current: FederatedDispatchObservationFence,
  expected: FederatedDispatchObservationFence
): boolean {
  return Object.keys(expected).every(
    (key) =>
      current[key as keyof FederatedDispatchObservationFence] ===
      expected[key as keyof FederatedDispatchObservationFence]
  )
}

export type FederatedDispatchObservationFenceMethods = {
  captureFederatedDispatchObservationFence: typeof captureFederatedDispatchObservationFence
  captureFederatedDispatchObservationFences: typeof captureFederatedDispatchObservationFences
  projectFederatedDispatchObservation: typeof projectFederatedDispatchObservation
}

export function attachFederatedDispatchObservationFence(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    captureFederatedDispatchObservationFence,
    captureFederatedDispatchObservationFences,
    projectFederatedDispatchObservation
  })
}
