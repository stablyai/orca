import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../shared/agent-session-wire'
import { latestStructuredAgentSessionTurn } from '../../../shared/structured-agent-session-live-turn'

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
