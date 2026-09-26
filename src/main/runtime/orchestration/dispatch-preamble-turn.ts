/**
 * A chat assignee's dispatch preamble, owed as a turn.
 *
 * A PTY assignee has its preamble typed into its pane, where a busy agent queues it. A chat takes
 * input only as a turn, and a turn sent mid-turn folds into the running one, so the preamble is
 * stored as the one `dispatch` message in the Dispatch's mailbox and the structured mail lane
 * delivers it: it waits out a running turn or a question only a human can answer, wakes an
 * evicted chat, and is found again at the chat's idle edge after a restart. It dies with the
 * Dispatch, because that lane reaches a chat's Dispatch mailbox only while the Dispatch is active.
 */

import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'

const PREAMBLE_TURN_POLL_MS = 250

/** Stores the owed preamble and hands it to the lane; returns the message that carries it. */
export function queueDispatchPreambleTurn(
  runtime: Pick<OrcaRuntimeService, 'notifyMessageArrived'>,
  db: OrchestrationDb,
  args: { dispatchId: string; runId: string; from: string; preamble: string }
): string {
  const message = db.insertMessage({
    from: args.from,
    to: `dispatch:${args.dispatchId}`,
    subject: `Dispatch ${args.dispatchId}`,
    body: args.preamble,
    type: 'dispatch',
    runId: args.runId
  })
  runtime.notifyMessageArrived(message.to_handle, message.type)
  return message.id
}

/**
 * Whether the preamble became a turn the chat's provider accepted within `timeoutMs`: the lane marks
 * it read then, and only then. False is not a failure; the lane still owes and delivers it.
 */
export async function waitForDispatchPreambleTurn(
  db: OrchestrationDb,
  messageId: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (db.getMessageById(messageId)?.read) {
      return true
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(PREAMBLE_TURN_POLL_MS, remaining)))
  }
}
