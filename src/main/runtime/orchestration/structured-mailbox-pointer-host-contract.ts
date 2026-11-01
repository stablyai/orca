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
  /** A card still waiting in the queue, or a handoff not yet answered. */
  | 'waiting'
  /** The agent was handed it, or the person deleted its card. */
  | 'handed'
  /** Rejected or left unanswered: it may never have reached the agent. */
  | 'lost'
  /** Nothing recorded under the id: the send never landed. */
  | 'absent'
  /** The session cannot be read now. */
  | 'unreadable'

export type StructuredMailboxPointerHost = {
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
    /** Rechecked at admission: the mail may have been consumed while the send waited. */
    stillOwed: () => boolean
  }) => Promise<StructuredPointerSendOutcome>
  observe: (sessionId: string, operationId: string) => Promise<StructuredMailSendState>
  /** Whether a lost send is worth repeating: the agent accepted a turn since, or a /clear replaced
   *  the context it went to. Edges alone never repeat it, so an agent dying on every start is not
   *  restarted by each one. */
  repeatable: (sessionId: string, sent: { atMs: number; fence: number }) => Promise<boolean>
  /** Delete a card still waiting in the queue; false when it could not be deleted now. */
  withdraw: (sessionId: string, operationId: string) => Promise<boolean>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
}
