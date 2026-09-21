import type Database from '../../sqlite/sync-database'
import type { DispatchContextRow, DispatchStatus } from './types'
import { transitionLifecycleWithDb } from './db/lifecycle-transition'

export type ContextOnlyDispatchReleaseState = 'abandoned' | 'stopped' | DispatchStatus

export type ContextOnlyDispatchReleaseResult = {
  state: ContextOnlyDispatchReleaseState
  alreadySettled: boolean
  releasedCurrentTask: boolean
}

export function contextOnlyAbandonWarning(result: {
  state: string
  alreadySettled: boolean
  releasedCurrentTask: boolean
}): string {
  if (result.alreadySettled) {
    return `Dispatch was already ${result.state}; no state or process changed.`
  }
  return result.releasedCurrentTask
    ? 'The assignment was abandoned; its unsupervised terminal process was retained.'
    : 'The superseded assignment was abandoned without changing the current Task or terminal process.'
}

export function releaseContextOnlyDispatch(
  db: Database.Database,
  dispatch: DispatchContextRow,
  requestedState: 'abandoned' | 'stopped'
): ContextOnlyDispatchReleaseResult {
  if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
    return {
      state: persistedReleaseState(dispatch),
      alreadySettled: true,
      releasedCurrentTask: false
    }
  }

  transitionLifecycleWithDb(db, {
    entity: 'dispatch',
    id: dispatch.id,
    from: dispatch.status,
    to: 'failed',
    projection: {
      last_failure: requestedState,
      capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString(),
      completed_at: dispatch.completed_at ?? new Date().toISOString()
    }
  })
  const remaining = db
    .prepare(
      `SELECT 1 FROM dispatch_contexts
       WHERE task_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`
    )
    .get(dispatch.task_id)
  let releasedCurrentTask = false
  if (!remaining) {
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dispatch.task_id) as
      | { status: string }
      | undefined
    if (task?.status === 'dispatched') {
      releasedCurrentTask = transitionLifecycleWithDb(db, {
        entity: 'task',
        id: dispatch.task_id,
        from: 'dispatched',
        to: 'blocked'
      }).changed
    }
  }
  return { state: requestedState, alreadySettled: false, releasedCurrentTask }
}

function persistedReleaseState(dispatch: DispatchContextRow): ContextOnlyDispatchReleaseState {
  return dispatch.last_failure === 'abandoned' || dispatch.last_failure === 'stopped'
    ? dispatch.last_failure
    : dispatch.status
}
