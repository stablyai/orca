import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalResetReason,
  AgentJournalRowAttribution,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLoad } from './journal-open'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

export type AgentSessionJournalOptions = {
  identity: AgentSessionJournalIdentity
  journalDir: string
  now?: () => number
  mintEpoch?: () => string
  /** A caller that already loaded the journal can avoid reading the same files again. */
  loaded?: JournalLoad | null
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
    | { state: 'rejected' | 'unknown'; reason?: string | null }
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
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}
