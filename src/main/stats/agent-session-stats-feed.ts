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

/** Use hook transitions on desktop/orcad (#31112); OSC titles miss hook-only agents and mistake spinner TUIs for work (#10201). */
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
