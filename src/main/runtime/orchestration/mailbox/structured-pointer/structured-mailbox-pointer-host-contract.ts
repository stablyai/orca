import type { ChatMailPlace } from '../../../../../shared/connectors/external-conversation-link'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { OrchestrationMessageWaiter } from '../terminal-pointer/mailbox-pointer-eligibility'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import type { SenderSnapshotResolver } from '../senders/agent-message-sender'
import type { BotItemReportFact } from '../../../../../shared/bots/bot-item-report-hint'
/** What the structured mailbox lane needs from a chat host: ordinary sends, and reads of what became of them. */
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredSendAnswer as StructuredMailSendState } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'
import type { MessageRow } from '../../db/orchestration-records'
import type { ReportFollowUpAction } from '../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'
import type {
  JournalMailAttempt,
  JournalMailObservation
} from '../../../../native-chat/agent-session-journal/journal-mail-observation'

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
  observeMail?: (attempt: JournalMailAttempt) => Promise<JournalMailObservation>
  /** Have the chat's queue look again: a card it passed over may be decidable now. */
  wakeQueue: (sessionId: string) => void
  /** Delete a waiting card and report its actual withdrawal or handoff outcome. */
  withdraw: (sessionId: string, operationId: string) => Promise<StructuredMailSendState>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  /** Coalesced journal publications of a session; returns the unsubscribe. */
  watchJournal: (sessionId: string, onActivity: () => void) => () => void
  /** The session owner may narrow selected mail before it is sent, to mail one turn can carry;
   *  `ended` is mail it will never carry, retired so selection moves past it. */
  narrowBatch?: StructuredMailOwner['narrowBatch']
  mailHeld?: StructuredMailOwner['mailHeld']
}

/** A session owner's rules for the mail it receives: what one turn carries, and admitting it. */
export type StructuredMailOwner = {
  narrowBatch: (
    sessionId: string,
    messages: MessageRow[]
  ) => { messages: MessageRow[]; ended: string[] }
  beforeSend: (input: Parameters<StructuredMailboxPointerHost['send']>[0]) => void
  /** The session takes no mail now (a paused bot's chat): it stays unread, and waiting cards stay queued. */
  mailHeld: (sessionId: string) => boolean
}

export type StructuredMailFollowUp = (
  db: OrchestrationDb,
  message: MessageRow,
  sessionId: string
) => ReportFollowUpAction | undefined

/** The open item a finished worker's report was started for; null when none. */
export type StructuredMailReportItem = (
  db: OrchestrationDb,
  message: MessageRow
) => Promise<BotItemReportFact | null>

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
  /** What a chat's mail offers in place of `[Reply:]`; a finished report's follow-up unless the runtime says. */
  replyFollowUp?: StructuredMailFollowUp
  /** The item a finished worker's report names, read at each delivery. */
  reportItem?: StructuredMailReportItem
  /** The chat's bound conversation and whether its answer to this mail lands there; null if unbound. */
  conversationPlace?: (sessionId: string, from: AgentMessageSource) => ChatMailPlace | null
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderSnapshotReader?: () => SenderSnapshotResolver
  senderSnapshot: SenderSnapshotResolver
  host: StructuredMailboxPointerHost
}
