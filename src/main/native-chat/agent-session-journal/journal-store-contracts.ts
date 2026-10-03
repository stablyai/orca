import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage,
  AgentJournalRejectionCause,
  AgentJournalResetReason,
  AgentJournalRowAttribution,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import type { JournalRow, JournalStartRetryRecord } from './journal-row-schema'

export type AgentSessionJournalOptions = {
  identity: AgentSessionJournalIdentity
  database: JournalHostDatabase
  now?: () => number
  mintEpoch?: () => string
  /** A restore's open: see `AgentSessionJournal.whenImported`. */
  deferPerSessionImport?: boolean
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
    /** Still queued: the start it was for was refused, and its next try is booked. */
    | { state: 'pending'; startRetry: JournalStartRetryRecord }
    /** Queued again by the person's Retry; see `JournalDispatchRow.requeued`. */
    | { state: 'pending'; requeued: true }
    /** `reason` is what released clients print, `rejection` what newer ones read: both from
     *  `agentSessionFailureWords`, never written by hand. */
    | ({
        state: 'rejected'
        rejectionCause?: AgentJournalRejectionCause
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
  /** The queue's own send: refused in the consume's transaction while the queue's pause, as
   *  this host instance derives it, holds the card. Send-now omits it. */
  yieldsToPause?: { hostInstance: string }
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}
