import type { OrchestrationDb } from './db'
import type { DispatchContextRow, MessageType } from './types'

/** Reports about the worker's own task; gates and handoffs stay with the Run's coordinator. */
export function isDispatchReportType(type: MessageType | undefined): boolean {
  return (
    type === undefined ||
    type === 'worker_done' ||
    type === 'heartbeat' ||
    type === 'escalation' ||
    type === 'status'
  )
}

/** The live Dispatch that started this one in the same Run: the worker it reports to. */
export function activeCreatorDispatch(
  db: OrchestrationDb,
  dispatch: Pick<DispatchContextRow, 'creator_dispatch_id' | 'run_id'>
): DispatchContextRow | undefined {
  const creator = dispatch.creator_dispatch_id
    ? db.getDispatchContextById(dispatch.creator_dispatch_id)
    : undefined
  return creator &&
    creator.run_id === dispatch.run_id &&
    (creator.status === 'pending' || creator.status === 'dispatched')
    ? creator
    : undefined
}

/** Resolve the live creator or Run on each send so helpers follow creator settlement without rewriting routes. */
export function dispatchReportMailbox(
  db: OrchestrationDb,
  dispatch: Pick<DispatchContextRow, 'creator_dispatch_id' | 'run_id'>
): string {
  const creator = activeCreatorDispatch(db, dispatch)
  return creator ? `dispatch:${creator.id}` : `run:${dispatch.run_id}`
}
