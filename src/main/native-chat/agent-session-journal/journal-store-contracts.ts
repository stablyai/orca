import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage,
  AgentJournalResetReason,
  AgentJournalRowAttribution,
  AgentJournalSubmission,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../shared/agent-session-message-source'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

export type AgentSessionJournalOptions = {
  identity: AgentSessionJournalIdentity
  database: JournalHostDatabase
  now?: () => number
  mintEpoch?: () => string
}

export type JournalReadSince =
  | { ok: true; rows: JournalRow[]; cursor: AgentJournalCursor }
  | { ok: false; reset: AgentJournalResetReason }

export type ResolveDispatchInput = {
  clientMessageId: string
  fence: number
  recovered?: true
} &
  /** A null identity: the provider took the message without echoing an item of its own, as a
   *  conversation command it carries out in place. */
  (
    | { state: 'accepted'; providerIdentity: AgentJournalItemIdentity | null }
    /** The turn the message is handed into — the live root turn, or `thread` when none runs. */
    | { state: 'pending'; turnScope: AgentJournalTurnScope }
    /** `reason` is what released clients print, `rejection` what newer ones read: both from
     *  `agentSessionFailureWords`, never written by hand. */
    | ({
        state: 'rejected'
        keptAsQueuedMessageId?: string
        answeredInTurn?: AgentJournalAnsweredTurnIdentity
      } & AgentJournalDispatchRejection)
    | { state: 'unknown'; reason?: string | null }
  )

export type JournalAppendResult = {
  cursor: AgentJournalCursor
  itemId: string
  revision: number
}

export type JournalItemAppendOptions = AgentJournalRowAttribution & {
  fence: number
  observedAt?: number
  recovered?: true
}
export type JournalTombstoneInput = { fence: number }

/** One reduced item, the producer that wrote it and the turn it was created beside. */
export type JournalItemLinkageVisitor = (
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  attribution: AgentJournalProducerLinkage & { turnScope?: AgentJournalTurnScope }
) => void

export type JournalLifecycleBatchInput = {
  settlementId: string
  mutations: readonly JournalLifecycleMutationInput[]
  fence: number
  recovered?: true
  /** Rejects that send first, in the same append: a failed start's row follows the message it
   *  failed, and no reader meets one without the other. */
  rejects?: JournalBatchRejection
}

/** One send a batch rejects, when `which` still holds for it on the lane. When it no longer does —
 *  a Stop withdrew it, another writer settled it — the batch is not written either. */
export type JournalBatchRejection = AgentJournalDispatchRejection & {
  clientMessageId: string
  which: (submission: AgentJournalSubmission) => boolean
}

export type JournalResolvedLifecycleBatchInput = Omit<
  JournalLifecycleBatchInput,
  'mutations' | 'rejects'
> & {
  /** Read from the fold with every earlier write landed; may return none. */
  resolve: () => readonly JournalLifecycleMutationInput[]
}

export type JournalSubmissionInput = {
  clientMessageId: string
  payloadFingerprint: string
  body: AgentJournalMessageItem
  fence: number
  /** The send is accepted now and handed over later, by a `dispatch{pending}` row. */
  handoverRecorded?: true
  /** Stamped by `appendSubmission` from its consume; a caller-passed value must match it. */
  queuedMessageId?: string
  /** Who asked for this turn (`JournalSubmissionRow.origin`). */
  origin?: 'client' | 'host'
  /** Who it is from (`JournalSubmissionRow.source`); the row keeps the kind only. */
  source?: Pick<AgentSessionMessageSource, 'kind'>
}

/** A submission append that converts a queued draft, in one transaction. */
export type JournalSubmissionConsume = {
  messageId: string
  expect: 'waiting' | 'returned'
  /** The operation ledger's caller-scoped key; null for the host's own drain. */
  settledByOp: string | null
  /** The host process handing it off, stamped on the draft so a hand-off withdrawn back to
   *  waiting belongs to the process that sent it, not the one that first wrote the card. */
  hostInstance?: string
  /** The queue's own send: refused in the consume's transaction while the queue's pause holds
   *  the card. Send-now omits it. */
  yieldsToPause?: true
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}
