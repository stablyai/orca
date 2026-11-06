import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { PluginAgentStatusChangedPayload } from '../../shared/plugins/events/plugin-events'

/** Exclude restored rows from live automation triggers; optional mainAgent preserves old-host compatibility. */
export function projectPluginAgentStatusChangedPayload(
  enriched: Pick<
    EnrichedAgentHookEventPayload,
    'worktreeId' | 'paneKey' | 'receivedAt' | 'restoredUnconfirmed' | 'payload'
  >
): PluginAgentStatusChangedPayload | null {
  if (enriched.restoredUnconfirmed) {
    return null
  }
  const mainAgent = enriched.payload.mainAgent
  return {
    workspaceId: enriched.worktreeId ?? null,
    paneKey: enriched.paneKey,
    state: enriched.payload.state,
    receivedAt: enriched.receivedAt,
    ...(mainAgent
      ? {
          mainAgent: {
            state: mainAgent.state,
            ...(mainAgent.outcome ? { outcome: mainAgent.outcome } : {}),
            stateStartedAt: mainAgent.stateStartedAt
          }
        }
      : {})
  }
}
