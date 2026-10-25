import {
  AgentSessionTransitionRecorder,
  type AgentSessionClearEvent,
  type AgentSessionSink,
  type AgentSessionStatusEvent
} from './agent-session-transition-recorder'

export type AgentStatusSource = {
  subscribeEnrichedStatus(listener: (event: AgentSessionStatusEvent) => void): () => void
  subscribePaneStatusClear(listener: (clear: AgentSessionClearEvent) => void): () => void
}

/**
 * Counts agent sessions from hook status transitions, the same truth the sidebar and dashboard
 * read — never from OSC terminal titles, which miss hook-only agents and count any spinner TUI
 * as an agent (#10201). Both the desktop and orcad feed their collector through here (#31112).
 */
export function feedAgentSessionStats(
  stats: AgentSessionSink,
  source: AgentStatusSource
): () => void {
  const recorder = new AgentSessionTransitionRecorder(stats)
  const unsubscribeStatus = source.subscribeEnrichedStatus((event) => recorder.onStatus(event))
  const unsubscribeClear = source.subscribePaneStatusClear((clear) => recorder.onCleared(clear))
  return () => {
    unsubscribeStatus()
    unsubscribeClear()
  }
}
