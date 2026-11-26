import type { JournalRequestEvent } from './journal-request-failure'
import type { JournalOpenRecoveryResult } from './journal-sql-open-command'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterEffectResult } from './journal-writer-effects'
import type { JournalGoalAttachmentSnapshot } from './writing/journal-goal-attachment-inverse'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import type {
  AgentJournalRenderItem,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'

export type JournalPromptDispatch = {
  clientMessageId: string
  queuedMessageId?: string
  state: 'pending' | 'accepted' | 'rejected' | 'unknown'
}

export type JournalWriterPublication = {
  resetPrompts?: true
  promptDispatches?: JournalPromptDispatch[]
  items: AgentJournalRenderItem[]
  insertedItemIds?: string[]
  cards: QueuedMessageRow[]
  insertedCardIds?: string[]
  receipts: AgentJournalAcceptanceReceipt[]
  removedItemIds?: string[]
  invalidatedItemIds?: string[]
  placements?: { messageId: string; position: number }[]
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
  referencedUploads?: string[]
}

export type JournalWriterCommit = {
  forkInstalled?: { epoch: string; boundary: { kind: 'start' } | { kind: 'item'; itemId: string } }
  openRecovery?: JournalOpenRecoveryResult
  requestEvents?: JournalRequestEvent[]
  publication?: JournalWriterPublication
  cursor: AgentJournalCursor
  inputChanged: boolean
  queueRevision?: string
  keys: { collection: string; key: unknown; deleted: boolean }[]
  items: (
    | { itemId: string; deleted: true; revision: number }
    | { itemId: string; deleted: false; revision: number; sequence: number; sequenceIndex: number }
  )[]
  /** First presence before this command changed a submission key; captures ignore older cursors. */
  inputKeys: [string, boolean][]
  effects: JournalWriterEffectResult[]
  /** The command's receipt was written in its transaction; absent when it rolled back or wrote none. */
  receiptWritten?: true
  /** The operation's own serializable answer (a cursor, card, update or move result). */
  value?: unknown
  /** The host adopts this copy of its goal attachment proofs after COMMIT. */
  goals?: JournalGoalAttachmentSnapshot
  /** The host adopts its staged stopped-cut withdrawal only when the writer applied it. */
  withdrewCut?: UsageLimitContinueIdentity
}
