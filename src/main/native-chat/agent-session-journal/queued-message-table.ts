// A queued message as every reader sees it: a card the journal fold derives from the chat's own
// rows (`journal-queue-fold.ts`). It becomes an ordinary submission when it is handed off, and the
// hand-off's answer settles it: a refusal returns it, one Orca proves never reached the agent waits
// again, and anything else spends it.
// The `queued_messages` table earlier builds wrote is read only to bring its cards into the
// journal (`journal-queue-import.ts`).

import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  AgentJournalCursor,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-queued-message-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'

export type QueuedMessageState = 'waiting' | 'dispatched' | 'returned' | 'withdrawn'

/** Why ONE waiting card is held from auto-sending: its conversion failed (`send_failed`). A wire
 *  marker (it publishes as `pausedReason`). A Stop, a /clear or a reopen pauses the queue instead. A
 *  reader treats an unknown value as a plain hold, and the holds earlier builds wrote that this one
 *  derives (`QUEUED_MESSAGE_RETIRED_HOLD_REASONS`) as none. */
export type QueuedMessageHoldReason = typeof QUEUED_MESSAGE_PAUSED_SEND_FAILED

/** Host-only: a card an earlier build put back to waiting whose hand-off may have reached the agent,
 *  edited or sent again since, so it waits for its own Send (`journal-queue-import.ts`). Published
 *  as a plain hold. */
export const QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED = 'delivery_unconfirmed'

/** Definitively unsettled: what Stop, /clear, Edit and the published-bytes bound count, and
 *  what the published list shows. Pending/unknown/accepted deliveries and
 *  withdrawn cards stay outside it. */
export function isUnsettledQueuedMessage(row: Pick<QueuedMessageRow, 'state'>): boolean {
  return row.state === 'waiting' || row.state === 'returned'
}

/** A fold card; the name is the one readers have always used. */
export type QueuedMessageRow = {
  messageId: string
  position: number
  body: AgentJournalMessageItem
  /** `agentSessionSendBodyFingerprint` of `body`, derived, never stored. */
  fingerprint: string
  state: QueuedMessageState
  /** Non-null holds this one waiting card from auto-sending; typed values in
   *  `QueuedMessageHoldReason`, unknown strings read as a plain hold. */
  holdReason: string | null
  /** A returned card's refusal, its hand-off's `reason` and `rejection` pair. */
  returnedReason: string | null
  returnedRejection: UnreadAgentSessionFailureFact | null
  /** The submission that last handed it off: set on every dispatched card, kept on a returned
   *  one, cleared when a withdrawal sends it back to waiting. Host-only; the published link is
   *  the submission's `queuedMessageId`. */
  consumedAs: string | null
  /** Where the journal stood when it was queued: a Stop's pause holds only cards queued before
   *  it. Null on cards from builds before it was recorded, which read as queued before any Stop. */
  queuedAt: AgentJournalCursor | null
  /** The choices its send carried, applied to the turn it starts when it goes out. */
  options?: AgentSessionExecutionOptions
}
