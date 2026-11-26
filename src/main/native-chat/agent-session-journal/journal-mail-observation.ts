import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

export type StructuredSendAnswer =
  /** Still the chat's to hand over: a card waiting, paused or returned, or a handoff not yet answered. */
  | { kind: 'waiting' }
  /** Its card was deleted before handover. */
  | { kind: 'withdrawn' }
  | { kind: 'accepted' }
  /** Sent at once and proven never delivered. `cancelled`: someone stopped it on purpose.
   *  `recovered`: a different turn was handed over and accepted, or the context cleared, after it settled. */
  | { kind: 'rejected'; cancelled: boolean; recovered: boolean }
  /** It may have reached the agent: admitted, with nothing left to say whether it did. */
  | { kind: 'unknown' }
  /** Refused before admission; its id would replay that refusal. */
  | { kind: 'refused' }
  /** A complete read, receipts included, proves it was never admitted. */
  | { kind: 'absent' }
  | { kind: 'unreadable' }

export type JournalMailAttempt = {
  mailbox_handle: string
  message_id: string
  session_id: string
  operation_id: string
}

export type JournalMailObservation = {
  epoch: string
  state: StructuredSendAnswer
  body: AgentJournalMessageItem | null
  withdrawal: 'system' | 'person' | 'unknown'
}
