import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'

/** Compare provider history against the existing chat at open. */
export type StructuredAgentSessionHistoryJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'reads' | 'readInOrder'
>

export type StructuredAgentSessionLinkageJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItemsWithLinkage' | 'threadGoal' | 'threadGoalSource'
>
