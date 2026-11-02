/** What the structured mailbox lane needs from a chat host: ordinary sends, and reads of what became of them. */

import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

export type StructuredPointerSendOutcome =
  /** The chat's queue took it, as it takes a person's message sent while the agent works. */
  | { kind: 'queued' }
  /** Sent at once; `pending` is still waiting on the agent's answer. */
  | { kind: 'sent'; state: 'accepted' | 'pending' | 'rejected' | 'unknown' }
  /** Refused before anything was recorded (for example a full queue); nothing to observe. */
  | { kind: 'refused' }
  | { kind: 'unattached' }
  /** A check took or a waiter claimed its mail before admission; nothing ran. */
  | { kind: 'obsolete' }

/** What became of one earlier send, read from the chat's journal without replaying it. */
export type StructuredMailSendState =
  /** Still the chat's to hand over: a card waiting, paused or returned, or a handoff not yet answered. */
  | { kind: 'waiting' }
  /** Its card was deleted before handover. */
  | { kind: 'withdrawn' }
  | { kind: 'accepted' }
  /** Sent at once and proven never delivered. `cancelled`: someone stopped it on purpose.
   *  `recovered`: a turn was accepted, or the context cleared, after the rejection settled. */
  | { kind: 'rejected'; cancelled: boolean; recovered: boolean }
  /** It may have reached the agent; nothing says whether it did. */
  | { kind: 'unknown' }
  /** A complete read found nothing under its id: it was never admitted. */
  | { kind: 'absent' }
  /** The session cannot be read now. */
  | { kind: 'unreadable' }

export type StructuredMailboxPointerHost = {
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
    /** Rechecked at admission: the mail may have been taken, or its owner changed, while the send waited. */
    stillOwed: () => boolean
  }) => Promise<StructuredPointerSendOutcome>
  observe: (sessionId: string, operationId: string) => Promise<StructuredMailSendState>
  /** Delete a card still waiting in the queue; false when it could not be deleted now. */
  withdraw: (sessionId: string, operationId: string) => Promise<boolean>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  /** Coalesced journal publications of a session; returns the unsubscribe. */
  watchJournal: (sessionId: string, onActivity: () => void) => () => void
}
