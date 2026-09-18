import {
  clearPaneCacheState,
  type HookListenerState
} from '../shared/agent-hook-listener/listener-state'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { selectReplayableCachedPanes } from './agent-hook-cached-pane-status'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import type { AgentHookSource, AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

export function clearRelayPaneState(
  paneKey: string,
  state: HookListenerState,
  retryScheduler: AgentHookResultRetryScheduler,
  envelopeMetadata: { delete: (paneKey: string) => unknown }
): void {
  retryScheduler.clearAssistantMessageRetry(paneKey)
  retryScheduler.clearCodexSubagentPoll(paneKey)
  clearPaneCacheState(state, paneKey)
  envelopeMetadata.delete(paneKey)
}

export function replayRelayCachedPanes(input: {
  state: HookListenerState
  envelopeMetadata: Map<string, { source: AgentHookSource; env?: string; version?: string }>
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
  forward: (envelope: AgentHookRelayEnvelope) => void
}): number {
  const replayable = selectReplayableCachedPanes({
    cachedByPaneKey: new Map(input.state.lastStatusByPaneKey),
    metaByPaneKey: input.envelopeMetadata,
    isPaneSurfaceRetired: input.isPaneSurfaceRetired,
    dropPane: input.clearPaneState
  })
  for (const { event, meta } of replayable) {
    input.forward(
      buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, { isReplay: true })
    )
  }
  return replayable.length
}
