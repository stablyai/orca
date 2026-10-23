import { OrchestrationError } from '../../orchestration-error'
import type { DispatchContextRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { refuseRunAuthority, type RunActor } from './run-actor'
import { getRunAuthority } from './run-authority-store'

type ScopedRun = { id: string; home: string | null }

function assertNotAncestor(db: OrchestrationDb, start: ScopedRun, target: string): void {
  const complete = new Set<string>()
  const path = new Set<string>()
  function visit(current: ScopedRun): void {
    const key = JSON.stringify(current)
    if (path.has(key)) {
      refuseRunAuthority('This Run’s ownership lineage contains a cycle.')
    }
    if (complete.has(key)) {
      return
    }
    if (path.size + complete.size > 64) {
      refuseRunAuthority('This Run’s ownership lineage cannot be verified.')
    }
    path.add(key)
    if (current.home === null) {
      if (current.id === target) {
        throw new OrchestrationError(
          'worker_cannot_coordinate_own_run',
          'A worker cannot coordinate its own Run or an ancestor Run. Use plain orchestration check for your mail and orchestration send to report. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const authority = getRunAuthority(db, current.id)
      if (!authority) {
        refuseRunAuthority('This Run’s ownership lineage cannot be verified.')
      }
      if (authority.parent_run_id) {
        visit({ id: authority.parent_run_id, home: authority.creating_home_peer })
      }
      if (authority.owner_task_id && authority.owner_home_peer === null) {
        const task = db.getTask(authority.owner_task_id)
        if (task) {
          visit({ id: task.run_id, home: null })
        }
      }
    }
    path.delete(key)
    complete.add(key)
  }
  visit(start)
}

export function assertLocalDispatchCanCoordinate(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  runId: string
): void {
  let row: DispatchContextRow | undefined = dispatch
  const visited = new Set<string>()
  while (row) {
    if (visited.has(row.id) || visited.size >= 64) {
      refuseRunAuthority('This worker’s creation lineage contains a cycle.')
    }
    visited.add(row.id)
    assertNotAncestor(db, { id: row.run_id, home: null }, runId)
    if (!row.creator_dispatch_id) {
      break
    }
    const parent = db.getDispatchContextById(row.creator_dispatch_id)
    if (!parent) {
      refuseRunAuthority('This worker’s parent assignment cannot be verified.')
    }
    row = parent
  }
}

export function assertActorCanCoordinate(
  db: OrchestrationDb,
  actor: RunActor,
  runId: string
): void {
  if (actor.kind === 'local') {
    assertLocalDispatchCanCoordinate(db, actor.dispatch, runId)
  }
  if (actor.kind !== 'remote') {
    return
  }
  const origin = getRunAuthority(db, runId)
  // The attachment proves its home, not that home's ancestors. A recorded child is positive proof.
  if (
    !actor.attachment.home_run_id ||
    !origin ||
    origin.creating_home_peer !== actor.attachment.home_peer_fingerprint ||
    origin.creating_task_id !== actor.attachment.task_id ||
    origin.parent_run_id !== actor.attachment.home_run_id
  ) {
    refuseRunAuthority(
      'This remote worker’s relationship to the Run is unverifiable. Its coordinator must arrange recovery on the Run’s host.'
    )
  }
}

export function assertTaskCanOwnRun(db: OrchestrationDb, taskId: string, runId: string): void {
  const task = db.getTask(taskId)
  if (!task) {
    refuseRunAuthority('The hand-over target must be a Task on this host.')
  }
  const attempt = db.getDispatchContext(taskId)
  if (attempt && db.getFederatedDispatch(attempt.id)) {
    refuseRunAuthority(
      'A remote Task cannot accept a Task-target hand-over on this host. Use an exact caller target on its execution host.'
    )
  }
  assertNotAncestor(db, { id: task.run_id, home: null }, runId)
  const dispatch = db.getDispatchContext(taskId)
  if (dispatch) {
    assertLocalDispatchCanCoordinate(db, dispatch, runId)
  }
}
