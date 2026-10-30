import type { JournalItemEcho } from './journal-item-echo'
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
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRowWriter } from './journal-row-writer'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalWriteBody } from './journal-write-queue'

export type AgentSessionJournalOptions = {
  queueOrigin?: () => 'fresh' | undefined
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
  /** Null identity means the provider accepted without echoing an item, e.g. an in-place command. */
  (
    | { state: 'accepted'; providerIdentity: AgentJournalItemIdentity | null }
    /** Handover scope: live root turn, otherwise thread. */
    | {
        state: 'pending'
        turnScope: AgentJournalTurnScope
        carries?: readonly string[]
      }
    /** Generate both legacy reason text and typed rejection with agentSessionFailureWords. */
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
  echoOf?: JournalItemEcho['echoOf']
  fence: number
  /** Provider execution provenance; host bookkeeping omits it to retain the item's owner. */
  ownerFence?: number
  /** Fence of the reusable child process producing this write. */
  executionOwner?: number
  observedAt?: number
  recovered?: true
}
export type JournalTombstoneInput = { fence: number }

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
  /** Provider generation producing every item; host bookkeeping omits it. */
  ownerFence?: number
  recovered?: true
  /** Commit settlement verdicts before item rows. */
  dispatches?: readonly ResolveDispatchInput[]
  /** Atomically reject queued sends before the batch; skip the batch when none remain. */
  rejectsQueued?: AgentJournalDispatchRejection
}

/** Plan after preceding writes, including answers and Stops. */
export type JournalPlannedLifecycleBatchInput = Pick<
  JournalLifecycleBatchInput,
  'settlementId' | 'fence' | 'recovered'
> & {
  plan: () => {
    mutations: readonly JournalLifecycleMutationInput[]
    dispatches: readonly ResolveDispatchInput[]
  }
}

export type JournalResolvedLifecycleBatchInput = Omit<
  JournalLifecycleBatchInput,
  'mutations' | 'rejectsQueued' | 'dispatches'
> & {
  /** Read after earlier writes; empty means no mutations. */
  resolve: () => readonly JournalLifecycleMutationInput[]
}

export type JournalSubmissionInput = {
  humanRelease?: true
  clientMessageId: string
  payloadFingerprint: string
  body: AgentJournalMessageItem
  fence: number
  /** Acceptance precedes handover; dispatch/pending records delivery later. */
  handoverRecorded?: true
  /** Derived from consume; caller-provided values must match. */
  queuedMessageId?: string
  origin?: 'client' | 'host'
  /** Persist only the sender kind. */
  source?: Pick<AgentSessionMessageSource, 'kind'>
  options?: AgentSessionExecutionOptions
}

/** The submission's queue link constitutes the entire handoff. */
export type JournalSubmissionConsume = {
  messageId: string
  expect: 'waiting' | 'returned'
  /** Automatic drain honors pauses in the consume transaction; Send now omits this. */
  yieldsToPause?: true
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}

export type JournalQueuedMessagesDeps = {
  queueOrigin?: () => 'fresh' | undefined
  sessionId: string
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  state: () => JournalReducerState
  /** Fallback pause boundary when this handle could not write its reopen mark. */
  reopenFloor: () => AgentJournalCursor | null
  writer: JournalRowWriter
  /** Notify after legacy deletion that appends no row. */
  committed: () => void
  claimAttachments: JournalAttachmentClaim
}
