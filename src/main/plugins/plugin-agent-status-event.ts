import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { PluginAgentStatusChangedPayload } from '../../shared/plugins/events/plugin-events'
import {
  pluginEventWorkspaceListId,
  type PluginWorktreeMetaSource
} from './plugin-event-workspace-id'

/** Exclude restored rows from live automation triggers; optional mainAgent preserves old-host compatibility.
 *  `store` names each worktree by the id `workspace.list` gives it. */
export function projectPluginAgentStatusChangedPayload(
  enriched: Pick<
    EnrichedAgentHookEventPayload,
    'worktreeId' | 'paneKey' | 'receivedAt' | 'restoredUnconfirmed' | 'payload'
  >,
  store: PluginWorktreeMetaSource | null | undefined
): PluginAgentStatusChangedPayload | null {
  if (enriched.restoredUnconfirmed) {
    return null
  }
  const mainAgent = enriched.payload.mainAgent
  const listId = enriched.worktreeId
    ? pluginEventWorkspaceListId(store, enriched.worktreeId)
    : undefined
  return {
    workspaceId: enriched.worktreeId ?? null,
    ...(listId ? { workspaceListId: listId } : {}),
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
