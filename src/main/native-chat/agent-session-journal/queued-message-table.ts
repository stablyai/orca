// Derive cards from journal rows; read the legacy table only for import. Handoff outcomes return
// refusals, requeue proven non-delivery, and spend uncertain or accepted sends.

import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  AgentJournalCursor,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-queued-message-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'

export type QueuedMessageState = 'waiting' | 'dispatched' | 'returned' | 'withdrawn'

/** Per-card conversion hold; unknown reasons remain held, retired reasons derive from queue pauses. */
export type QueuedMessageHoldReason = typeof QUEUED_MESSAGE_PAUSED_SEND_FAILED

/** Edited legacy uncertain deliveries require explicit Send; publish as a plain hold. */
export const QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED = 'delivery_unconfirmed'

/** Only waiting/returned cards count toward Stop, clear, editing and published bounds. */
export function isUnsettledQueuedMessage(row: Pick<QueuedMessageRow, 'state'>): boolean {
  return row.state === 'waiting' || row.state === 'returned'
}

export type QueuedMessageRow = {
  messageId: string
  position: number
  body: AgentJournalMessageItem
  /** Derived from body; never stored. */
  fingerprint: string
  state: QueuedMessageState
  /** Unknown non-null reasons remain plain holds. */
  holdReason: string | null
  returnedReason: string | null
  returnedRejection: UnreadAgentSessionFailureFact | null
  /** Host-only handoff link; clear on proven withdrawal, retain on return. Clients use queuedMessageId. */
  consumedAs: string | null
  /** Legacy null predates any Stop; otherwise compare enqueue cursor against the pause. */
  queuedAt: AgentJournalCursor | null
  options?: AgentSessionExecutionOptions
}
