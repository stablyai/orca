import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { PluginAgentStatusChangedPayload } from '../../shared/plugins/plugin-events'

/**
 * The bounded `agent.status.changed` projection of one status-store row. `state` stays the
 * combined status; `mainAgent` rides beside it as the same optional fact the row carries. Restored
 * rows project to nothing: plugins may automate on `working`, and a hydrated row is a historical
 * claim, not fresh activity — its `mainAgent` no less than its `state`.
 */
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
    worktreeId: enriched.worktreeId ?? null,
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
