import { readAgentSessionHydrationPage } from '../publication/history/agent-session-history-page'
import { forkHistoryReader } from '../publication/history/agent-session-fork-marker'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

export async function prepareForkFounding(params: AgentSessionAttachParams): Promise<void> {
  if (!params.fork) {
    return
  }
  await params.fork.revalidate()
}

export function readForkHydration(
  journal: AgentSessionJournal,
  fence: number,
  store: AgentSessionRecordStore,
  sessionId: string
) {
  return readAgentSessionHydrationPage(journal, fence, forkHistoryReader(store, sessionId))
}
