import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'

export type ProviderReceiptDispatch = {
  journal: SqlAgentSessionJournal
  clientMessageId: string
  cursor: AgentJournalCursor
  fence: number
  provider: 'claude' | 'codex'
  owns: () => boolean
}
