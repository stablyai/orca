import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { OrchestrationMessageWaiter } from '../terminal-pointer/mailbox-pointer-eligibility'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import type { SenderSnapshotResolver } from '../senders/agent-message-sender'
/** What the structured mailbox lane needs from a chat host: ordinary sends, and reads of what became of them. */

import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredSendAnswer as StructuredMailSendState } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'

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
  /** Have the chat's queue look again: a card it passed over may be decidable now. */
  wakeQueue: (sessionId: string) => void
  /** Delete a card still waiting in the queue; false when it could not be deleted now. */
  withdraw: (sessionId: string, operationId: string) => Promise<boolean>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  /** Coalesced journal publications of a session; returns the unsubscribe. */
  watchJournal: (sessionId: string, onActivity: () => void) => () => void
}

export type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /** Resolve dispatch or direct-worker mail to its session; null delegates to the PTY lane. */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  redeliver?: (mailboxHandle: string) => void
  /** Whether nothing can own the mailbox again; read from the database unless a test supplies it. */
  mailboxEnded?: (mailboxHandle: string) => boolean
  /** Why no chat resolves a mailbox; read from the database unless a test supplies it. */
  unresolvedCustody?: (mailboxHandle: string) => 'elsewhere' | 'unverifiable'
  /** The CLI name the recipient runs, for the reply line and the oversized-message pointer. */
  getCliCommand: () => OrchestrationCliCommand
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderSnapshotReader?: () => SenderSnapshotResolver
  senderSnapshot: SenderSnapshotResolver
  host: StructuredMailboxPointerHost
}
