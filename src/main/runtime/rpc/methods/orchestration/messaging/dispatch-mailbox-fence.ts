import type { DispatchContextRow } from '../../../../orchestration/types'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'

export const DISPATCH_FENCED_MESSAGE =
  'This process no longer owns its Dispatch: the Attempt was re-attached to another worker or settled. Stop; do not send worker_done and do not retry the check.'

export function dispatchFenced(): OrchestrationError {
  return new OrchestrationError('consumer_fenced', DISPATCH_FENCED_MESSAGE)
}

/** Delivery fencing is generic; a worker needs to hear that it lost the Dispatch, not the Run. */
export function asDispatchFence(error: unknown): unknown {
  return error instanceof OrchestrationError && error.code === 'consumer_fenced'
    ? dispatchFenced()
    : error
}

// Why: the handle lookup outranks the pane one, so without this a stale process still holding the
// row's handle would read and ack the mailbox of the pane the Dispatch was re-pointed at.
export function callerHoldsDispatchPane(
  dispatch: { assignee_pane_key: string | null },
  paneKey: string | undefined
): boolean {
  return (
    paneKey === undefined ||
    dispatch.assignee_pane_key === null ||
    isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)
  )
}

/**
 * A terminal whose last Attempt was abandoned, stopped or failed must not read its direct mailbox:
 * an empty result is the worker contract's "checkpoint, not a failure", so the loser would keep
 * working on a Task another terminal now owns. A `completed` Attempt is not fenced — that terminal
 * is free again and may legitimately receive direct mail. Retries need no separate test: every
 * settle that makes an Attempt retry-eligible also drives its Dispatch to failed/circuit_broken.
 */
export function isSupersededDispatch(dispatch: DispatchContextRow): boolean {
  return dispatch.status === 'failed' || dispatch.status === 'circuit_broken'
}
