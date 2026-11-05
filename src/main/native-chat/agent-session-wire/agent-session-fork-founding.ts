import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { forkHistoryReader } from './agent-session-fork-marker'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import type { AgentSessionAttachParams, reserveRequestFor } from './structured-agent-session-attach'

export async function prepareForkFounding(
  params: AgentSessionAttachParams,
  request: ReturnType<typeof reserveRequestFor>,
  items: JournalReplacementItem[] | null
): Promise<void> {
  if (!params.fork) {
    return
  }
  await params.fork.revalidate()
  const last = items?.at(-1)
  request.forkedFrom = {
    sessionId: params.fork.sessionId,
    itemId: params.fork.itemId,
    childBoundary: last
      ? { kind: 'item', itemId: agentJournalItemKey(last.identity) }
      : { kind: 'start' }
  }
  request.conversationName = params.fork.title
}

export function readForkHydration(
  journal: AgentSessionJournal,
  fence: number,
  store: AgentSessionRecordStore
) {
  return readAgentSessionHydrationPage(
    journal,
    fence,
    forkHistoryReader(store, journal.currentRead().sessionId)
  )
}
