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
import type { JournalReducerState } from './journal-reducer'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalWriteBody } from './journal-write-queue'

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
  /** Bookkeeping no person waits on (`JournalWriteOptions`); not written to the row. */
  background?: true
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
  /** The generation whose execution produced the item: set by a provider's observation, and by
   *  nothing else. Host bookkeeping leaves it out and keeps the item's (`journalItemOwnerFence`). */
  ownerFence?: number
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
  /** A provider's own batch: the generation that produced every item it writes
   *  (`JournalItemAppendOptions.ownerFence`). */
  ownerFence?: number
  recovered?: true
  /** Submission verdicts belonging to this settlement, committed before its item rows. */
  dispatches?: readonly ResolveDispatchInput[]
  /** Rejects the sends still queued with this first, in the same append: a failed start's row
   *  follows the messages it failed, and no reader meets one without the other. With none still
   *  queued, the batch is not written either. */
  rejectsQueued?: AgentJournalDispatchRejection
  /** Narrows `rejectsQueued` to the queued sends this names. */
  rejectsQueuedOnly?: (submission: AgentJournalSubmission) => boolean
}

/** A lifecycle batch whose rows are chosen at its own turn in the write queue, so a write queued
 *  ahead of it (an answer, a Stop) is what it plans from. */
export type JournalPlannedLifecycleBatchInput = Pick<
  JournalLifecycleBatchInput,
  'settlementId' | 'fence' | 'recovered'
> & {
  /** Bookkeeping no person waits on (`JournalWriteOptions`). */
  background?: true
  plan: () => {
    mutations: readonly JournalLifecycleMutationInput[]
    dispatches: readonly ResolveDispatchInput[]
  }
}

export type JournalResolvedLifecycleBatchInput = Omit<
  JournalLifecycleBatchInput,
  'mutations' | 'rejectsQueued' | 'rejectsQueuedOnly' | 'dispatches'
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
  /** The queue's automatic send is bookkeeping no person waits on (`JournalWriteOptions`). */
  background?: true
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}

/** What `JournalQueuedMessages` reads from the journal that owns it. */
export type JournalQueuedMessagesDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  state: () => JournalReducerState
  /** Where the reopen's pause begins when this handle could not mark it (`reopenFloor`). */
  reopenFloor: () => AgentJournalCursor | null
  /** The journal's own commit notification. Every standalone draft-table
   *  transaction that changed rows fires it after COMMIT, so a draft or hold
   *  change publishes and wakes the drain through the same path a journal row
   *  does — no call site can forget. In-transaction consume and the returned
   *  transition already ride their row's own commit. */
  committed: () => void
  claimAttachments: JournalAttachmentClaim
}
