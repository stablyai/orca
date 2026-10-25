import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionLifecycleJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItems'
>

export type StructuredAgentSessionIdentityResolver = (
  journal: StructuredAgentSessionLifecycleJournal
) => AgentJournalItemIdentity | null

export type StructuredAgentSessionRevisionJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItems' | 'itemBody' | 'item'
>

/** Compare provider history against the existing chat at open. */
export type StructuredAgentSessionHistoryJournal = Pick<
  AgentSessionJournal,
  | 'epoch'
  | 'cursor'
  | 'visitItems'
  | 'visitItemsWithLinkage'
  | 'item'
  | 'receiptFor'
  | 'submissions'
  | 'historyOrigin'
>

export type StructuredAgentSessionLinkageJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItemsWithLinkage' | 'threadGoal' | 'threadGoalSource'
>

/** Resolve the revised row and full replacement body at execution time. */
export type StructuredAgentSessionRevisionResolver = (
  journal: StructuredAgentSessionRevisionJournal
) => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null
