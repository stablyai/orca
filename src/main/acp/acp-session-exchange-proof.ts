import type { AcpStructuredLaunchPartDeps } from './acp-structured-launch-resolution'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isProviderTimelineTurnInNamespace } from '../native-chat/agent-session-timeline/provider-timeline-identity'

export async function nothingExchangedOn(
  readJournal: AcpStructuredLaunchPartDeps['readJournal'],
  sessionId: string,
  nativeId: string
): Promise<boolean> {
  let load: JournalLoad | null
  try {
    load = await readJournal(sessionId)
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
