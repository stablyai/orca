/**
 * Names the mailbox a dual-role pane is NOT being served.
 *
 * `run-create` binds the creating pane for life and `check` serves that bound Run ahead of any
 * Dispatch, so a terminal that both coordinates an older child Run and is currently a dispatched
 * worker reads Run mail forever while its Dispatch mail sits unreachable. The precedence is
 * deliberate — an intentional child coordinator must keep its Run — but the silence is not: a
 * worker cannot act on a redirect it is never told exists.
 *
 * Routing is unchanged. This only reports the mailbox the caller is missing.
 */

import type { OrchestrationDb } from '../../../../orchestration/db'
import { callerHoldsDispatchPane } from './dispatch-mailbox-fence'

export type UnservedDispatchMailbox = {
  kind: 'dispatch'
  dispatchId: string
  /** Unread count in the mailbox NOT being served, so the report is actionable, not just a hint. */
  unread: number
  /** The selector that reaches it, so the worker does not have to derive one. */
  readWith: string
}

export function unservedDispatchMailbox(input: {
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
}): UnservedDispatchMailbox | undefined {
  const dispatch = input.db.getActiveDispatchForIdentity(input.handle, input.paneKey)
  // The same pane test the Dispatch branch fences on: another pane's Dispatch is not this
  // caller's to be told about, let alone to read.
  if (!dispatch || !callerHoldsDispatchPane(dispatch, input.paneKey)) {
    return undefined
  }
  return {
    kind: 'dispatch',
    dispatchId: dispatch.id,
    unread: input.db.getUnreadMessages(`dispatch:${dispatch.id}`).length,
    readWith: `--dispatch ${dispatch.id}`
  }
}

/** Adds the field only when there is something to say, so every other receipt is byte-identical. */
export function withUnservedDispatchMailbox<T>(
  receipt: T,
  unserved: UnservedDispatchMailbox | undefined
): T {
  return unserved && receipt !== null && typeof receipt === 'object'
    ? { ...receipt, unservedMailbox: unserved }
    : receipt
}
