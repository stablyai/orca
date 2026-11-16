import type { JournalOpenRecoveryResult } from './journal-sql-open-command'
import type { JournalItemEcho } from './projection/journal-item-echo'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemBody,
  AgentJournalResolution,
  AgentJournalRenderItem,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage,
  AgentJournalResetReason,
  AgentJournalRowAttribution,
  AgentJournalTurnItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { JournalTransactionalDatabase } from './database/journal-host-database'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { JournalLifecycleMutationInput } from './writing/journal-lifecycle-mutation'
import type { JournalRowsRead } from './replay/journal-read-row'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalOperationReceipt, JournalRowWriter } from './writing/journal-row-writer'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import type Database from '../../sqlite/sync-database'
import type { JournalStopEvent } from './durable-rows/journal-row-schema'
import type { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { StaleStructuredAgentSessionStateInput } from '../agent-session-wire/termination/structured-agent-session-stale-state-settlement'
import type { StructuredAgentSessionExitSettlement } from '../agent-session-wire/termination/structured-agent-session-leftover-settlement'

export type JournalStaleSettlementInput = Omit<StaleStructuredAgentSessionStateInput, 'journal'>

export type JournalDeadGenerationSettlementInput = Omit<
  JournalStaleSettlementInput,
  'acquisitionGeneration'
> & {
  exit?: StructuredAgentSessionExitSettlement
  continuingInputs: readonly string[]
  finalizingInputs: readonly { clientMessageId: string; settlementOwner?: true }[]
}

/** Running root turns under `fence` other than `liveTurnId` are over; selected at the write. */
export type JournalUnheldTurnsSettlementInput = {
  sessionId: string
  fence: number
  generation: string
  liveTurnId: string | null
}

export type JournalStartFailureSettlementInput = AgentJournalDispatchRejection & {
  startKey: string
  clientMessageId: string | null
  fence: number
}

export type JournalPromptMutationInput = {
  itemId: string
  expectedRevision: number
  kind?: 'approval' | 'question'
  resolution: AgentJournalResolution
  options: JournalItemAppendOptions
}

export type AgentSessionJournalOptions = {
  identity: AgentSessionJournalIdentity
  database: JournalSqlDatabase
  now?: () => number
  mintEpoch?: () => string
  recover?: { fence: number }
  onRecoveryFailure?: (failure: JournalOpenRecoveryResult['failures'][number]) => void
  /** Saves a person's Stop of limited work in the same commit as the rows that reveal it. */
  withdrawStoppedCut?: (cut: UsageLimitContinueIdentity) => JournalOperationReceipt | undefined
}

export type JournalReadSince =
  | ({ ok: true; cursor: AgentJournalCursor } & JournalRowsRead)
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

export type JournalLateDispatchInput =
  | Extract<ResolveDispatchInput, { state: 'accepted' | 'unknown' }>
  | (Extract<ResolveDispatchInput, { state: 'rejected' }> & { unrun?: true })

export type JournalItemAppendOptions = AgentJournalRowAttribution & {
  /** Resolve the provider's stopped turn at the write position, falling back to turnScope. */
  onlyBetweenTurns?: true
  stoppedTurnId?: string
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
  attribution: AgentJournalProducerLinkage & { turnScope?: AgentJournalTurnScope },
  item: AgentJournalRenderItem
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
  keepFailedStart?: boolean
}

/** Plan after preceding writes, including answers and Stops. */
export type JournalPlannedLifecycleBatchInput = Pick<
  JournalLifecycleBatchInput,
  'settlementId' | 'fence' | 'recovered' | 'keepFailedStart'
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
  /** Re-asked in the handover transaction: an agent's message can stop being owed while it waits. */
  owed?: () => QueuedMessageOwed
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}

export type JournalShutdownCutInput = {
  identity: AgentJournalItemIdentity
  body: Extract<AgentJournalItemBody, { kind: 'status' }>
  turnItemId: string
  fence: number
}

export type JournalCommandOpenInput = Pick<
  Extract<ResolveDispatchInput, { state: 'pending' }>,
  'clientMessageId' | 'fence' | 'turnScope'
> & { submittedAt: number }

export type JournalHandoverInput = Pick<
  Extract<ResolveDispatchInput, { state: 'pending' }>,
  'clientMessageId' | 'fence' | 'turnScope'
> & { body: AgentJournalMessageItem }

export type JournalCommandSettlementInput = {
  dispatch: Extract<ResolveDispatchInput, { state: 'rejected' | 'unknown' }>
  failureBody?: Extract<AgentJournalItemBody, { kind: 'status' }>
}

export type JournalQueuedMessagesDeps = {
  sessionId: string
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalTransactionalDatabase
  readOnly: () => boolean
  state: () => JournalReducerState
  /** Fallback pause boundary when this handle could not write its reopen mark. */
  reopenFloor: () => AgentJournalCursor | null
  writer: JournalRowWriter
  /** Notify after legacy deletion that appends no row. */
  committed: () => void
  claimAttachments: JournalAttachmentClaim
  /** The SQL writer receives the host's edit holds as data; otherwise this handle's leases. */
  editHeld?: (messageId: string) => boolean
}

export type JournalStopAcceptanceInput = {
  event: Omit<JournalStopEvent, 'at'>
  fence: number
  /** Read the live turn when the event is written. */
  liveTurnId: () => string | null
}

export type JournalStopAcceptance = {
  mark: AgentJournalCursor
  withdrawn: string[]
  /** Explicitly named turn, otherwise the turn live at write time. */
  turnId: string | null
}

export type JournalCommandOpenResult = {
  turn: ReturnType<typeof structuredAgentSessionCommandTurn>
  running: AgentJournalTurnItem
}

export type JournalAttachmentClaim = (
  db: Database.Database,
  body: AgentJournalMessageItem,
  required: boolean,
  previous?: AgentJournalMessageItem,
  goalId?: string
) => (() => void) | void

export type JournalWriteResult<T> = T extends PromiseLike<unknown> ? never : T
export type JournalWriteBody<T> = () => JournalWriteResult<T>
