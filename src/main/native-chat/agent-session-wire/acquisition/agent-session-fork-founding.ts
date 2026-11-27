import { readAgentSessionHydrationPage } from '../publication/history/agent-session-history-page'
import { forkHistoryReader } from '../publication/history/agent-session-fork-marker'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'

export function readForkHydration(
  journal: AgentSessionJournal,
  fence: number,
  store: AgentSessionRecordStore,
  sessionId: string
) {
  return readAgentSessionHydrationPage(journal, fence, forkHistoryReader(store, sessionId))
}
