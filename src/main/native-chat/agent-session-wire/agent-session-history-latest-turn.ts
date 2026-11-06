import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../shared/agent-session/agent-session-wire'
import { latestStructuredAgentSessionTurn } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { historyPageTaskList } from '../../../shared/native-chat/input/native-chat-journal-task-list'

export { historyPageTaskList as pageTaskList }

// A catch-up run pages one snapshot many times; its scan back to the turn record is paid once.
const latestTurnBySnapshot = new WeakMap<AgentJournalSnapshot, AgentSessionLatestTurn | null>()

export function snapshotLatestTurn(snapshot: AgentJournalSnapshot): AgentSessionLatestTurn | null {
  let latest = latestTurnBySnapshot.get(snapshot)
  if (latest === undefined) {
    latest = latestStructuredAgentSessionTurn(snapshot.items)
    latestTurnBySnapshot.set(snapshot, latest)
  }
  return latest
}

export function pageSnapshotTail(snapshot: AgentJournalSnapshot) {
  return {
    latestTurn: snapshotLatestTurn(snapshot),
    ...historyPageTaskList(snapshot)
  }
}
