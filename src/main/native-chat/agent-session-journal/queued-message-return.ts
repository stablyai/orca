// A card the host runs itself (a queued /clear) that could not run: returned with why, never handed
// off. Like a refused hand-off's card it blocks the cards behind it until its own Send or Delete.

import type Database from '../../sqlite/sync-database'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { JournalQueuedMessages } from './journal-queued-messages'

/** waiting → returned with no hand-off; a returned card asked again keeps its place with the newer
 *  reason. False when the card is no longer unsettled. */
export function returnUnsentQueuedCard(
  queued: Pick<JournalQueuedMessages, 'transact' | 'sessionId'>,
  input: {
    messageId: string
    reason: string | null
    rejection: UnreadAgentSessionFailureFact
    now: number
  }
): Promise<boolean> {
  return queued.transact(
    (db) => returnUnsentQueuedMessage(db, { ...input, sessionId: queued.sessionId }),
    (changed) => changed
  )
}

function returnUnsentQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    reason: string | null
    rejection: UnreadAgentSessionFailureFact
    now: number
  }
): boolean {
  const changed = db
    .prepare(
      `UPDATE queued_messages
       SET state = 'returned', hold_reason = NULL, returned_reason = ?, returned_rejection = ?, settled_at = ?
       WHERE session_id = ? AND message_id = ? AND state IN ('waiting', 'returned')`
    )
    .run(input.reason, JSON.stringify(input.rejection), input.now, input.sessionId, input.messageId)
  return Number(changed.changes ?? 0) > 0
}
