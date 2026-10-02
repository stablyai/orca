/**
 * A chat assignee's dispatch preamble, owed as a turn.
 *
 * A PTY assignee has its preamble typed into its pane, where a busy agent queues it. A chat takes
 * input only as a turn, and a turn sent mid-turn folds into the running one, so the preamble is
 * stored as its Dispatch's one `dispatch_preamble_turns` row, which is not mail, and the structured
 * mail lane sends it as a plain send: it waits out a running turn or a question only a human can
 * answer, a chat at rest is started by the send itself, and it is found again at the chat's idle
 * edge or at startup. It may be sent only while its Dispatch is active; the row is dropped when the
 * Dispatch ends.
 */

import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import type { DispatchPreambleTurnRow } from './db/dispatch-context/dispatch-preamble-turn-store'

// No event announces a delivered row, so worker-start polls it, bounded by the observation budget.
const PREAMBLE_TURN_POLL_MS = 250

export function queueDispatchPreambleTurn(
  runtime: Pick<OrcaRuntimeService, 'deliverPendingMessagesForHandle'>,
  db: OrchestrationDb,
  dispatchId: string,
  preamble: string
): void {
  db.putDispatchPreambleTurn(dispatchId, preamble)
  runtime.deliverPendingMessagesForHandle(`dispatch:${dispatchId}`)
}

/**
 * The preamble's row once the chat's provider accepted it as a turn, or as it stood when `timeoutMs`
 * ran out. A row that is gone (`undefined`) went with its Dispatch, which ended; nothing will deliver
 * it, so the wait ends there.
 */
export async function awaitDispatchPreambleTurnDelivered(
  db: OrchestrationDb,
  dispatchId: string,
  timeoutMs: number
): Promise<DispatchPreambleTurnRow | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = db.getDispatchPreambleTurn(dispatchId)
    const remaining = deadline - Date.now()
    if (row?.state === 'delivered' || row === undefined || remaining <= 0) {
      return row
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(PREAMBLE_TURN_POLL_MS, remaining)))
  }
}
