import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalLoad } from '../../native-chat/agent-session-journal/replay/journal-open'
import { isProviderTimelineTurnInNamespace } from '../../native-chat/agent-session-timeline/provider-timeline-identity'

/** Missing journals count as empty; read errors or damaged/newer journals cannot prove no exchange. */
export function nothingExchangedOn(
  readJournal: (sessionId: string) => JournalLoad | null,
  sessionId: string,
  nativeId: string
): boolean {
  let load: JournalLoad | null
  try {
    load = readJournal(sessionId)
  } catch {
    return false
  }
  if (!load) {
    return true
  }
  if (load.damage || load.newer) {
    return false
  }
  for (const item of load.state.items.values()) {
    const turn = readAgentJournalTurn(item.body)
    if (turn && isProviderTimelineTurnInNamespace(turn.turnId, nativeId)) {
      return false
    }
  }
  return true
}
