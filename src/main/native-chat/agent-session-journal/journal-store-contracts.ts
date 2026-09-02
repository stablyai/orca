import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalResetReason,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalCompactionPolicy } from './journal-compaction'
import type { JournalLoad } from './journal-open'
import type { JournalPayloadLimits } from './journal-payload-bounds'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

export type AgentSessionJournalOptions = {
  identity: AgentSessionJournalIdentity
  journalDir: string
  limits?: JournalPayloadLimits
  compaction?: JournalCompactionPolicy
  /** Compact as the tail grows. Defaults on: without it the log never sheds. */
  autoCompact?: boolean
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
} & (
  | { state: 'accepted'; providerIdentity: AgentJournalItemIdentity }
  | { state: 'rejected' | 'unknown'; reason?: string | null }
)

export type JournalAppendResult = {
  cursor: AgentJournalCursor
  itemId: string
  revision: number
}

export type JournalItemAppendOptions = { fence: number; observedAt?: number; recovered?: true }
export type JournalBlobInput = { digest: string; payload: string }
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
}

export type JournalItemAppendInput = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: JournalItemAppendOptions
}
