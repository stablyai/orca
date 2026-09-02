import type Database from '../../sqlite/sync-database'
import type { DispatchContextRow, DispatchStatus } from './types'

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

  db.prepare(
    `UPDATE dispatch_contexts
     SET status = 'failed', last_failure = ?,
         capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')),
         completed_at = COALESCE(completed_at, datetime('now'))
     WHERE id = ? AND status IN ('pending', 'dispatched')`
  ).run(requestedState, dispatch.id)
  const remaining = db
    .prepare(
      `SELECT 1 FROM dispatch_contexts
       WHERE task_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`
    )
    .get(dispatch.task_id)
  const releasedCurrentTask = Boolean(
    !remaining &&
    db
      .prepare("UPDATE tasks SET status = 'blocked' WHERE id = ? AND status = 'dispatched'")
      .run(dispatch.task_id).changes
  )
  return { state: requestedState, alreadySettled: false, releasedCurrentTask }
}

function persistedReleaseState(dispatch: DispatchContextRow): ContextOnlyDispatchReleaseState {
  return dispatch.last_failure === 'abandoned' || dispatch.last_failure === 'stopped'
    ? dispatch.last_failure
    : dispatch.status
}
