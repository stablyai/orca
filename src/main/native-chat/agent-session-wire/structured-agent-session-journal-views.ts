// What a producer reads from the journal its sink is bound to: each a narrow view of one store.

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

/** What a revision reads: a keyed read for a row it can name, and the scan for one it cannot. */
export type StructuredAgentSessionRevisionJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItems' | 'itemBody' | 'item'
>

/** What a provider reads at open to tell its own saved history from what the chat already holds. */
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

/** Rows already journaled and who produced each, read by a producer that has to agree with them. */
export type StructuredAgentSessionLinkageJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItemsWithLinkage' | 'threadGoal' | 'threadGoalSource'
>

/** The row a revision rewrites and its whole new body, read from the journal at execution. */
export type StructuredAgentSessionRevisionResolver = (
  journal: StructuredAgentSessionRevisionJournal
) => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null
