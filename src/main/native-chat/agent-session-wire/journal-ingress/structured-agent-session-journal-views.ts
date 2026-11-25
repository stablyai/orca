import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'

/** Compare provider history against the existing chat at open. */
export type StructuredAgentSessionHistoryJournal = Pick<
  SqlAgentSessionJournal,
  'cursor' | 'reads' | 'readInOrder'
>
