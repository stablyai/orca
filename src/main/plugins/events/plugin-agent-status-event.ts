import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server/server-types'
import type { PluginAgentStatusChangedPayload } from '../../../shared/plugins/events/plugin-events'
import type { WorktreeMetaIdentitySource } from '../../persistence/worktree-meta-host-identity'
import { pluginAgentWorkspaceListId } from './plugin-event-workspace-id'
import { pluginAgentSessionId } from '../workers/host-api/plugin-workspace-projection'

/** Exclude restored rows from live automation triggers; optional mainAgent preserves old-host compatibility.
 *  `store` names each worktree by the id `workspace.list` gives it. */
export function projectPluginAgentStatusChangedPayload(
  enriched: Pick<
    EnrichedAgentHookEventPayload,
    | 'worktreeId'
    | 'connectionId'
    | 'paneKey'
    | 'receivedAt'
    | 'restoredUnconfirmed'
    | 'payload'
    | 'providerSession'
  >,
  store: WorktreeMetaIdentitySource | null | undefined
): PluginAgentStatusChangedPayload | null {
  if (enriched.restoredUnconfirmed) {
    return null
  }
  const mainAgent = enriched.payload.mainAgent
  const sessionId = pluginAgentSessionId(enriched.providerSession)
  const listId = enriched.worktreeId
    ? pluginAgentWorkspaceListId(store, enriched.worktreeId, enriched.connectionId)
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
      : {}),
    ...(sessionId ? { sessionId } : {})
  }
}

export type ForwardedPluginAgentStatus = {
  payload: PluginAgentStatusChangedPayload
  terminalHandle?: string
}

/** Same status as last forwarded for the pane, apart from when it was received. */
export function pluginAgentStatusRestates(
  previous: ForwardedPluginAgentStatus | undefined,
  next: ForwardedPluginAgentStatus
): boolean {
  if (!previous || previous.terminalHandle !== next.terminalHandle) {
    return false
  }
  const a = previous.payload
  const b = next.payload
  return (
    a.workspaceId === b.workspaceId &&
    a.workspaceListId === b.workspaceListId &&
    a.state === b.state &&
    a.sessionId === b.sessionId &&
    a.mainAgent?.state === b.mainAgent?.state &&
    a.mainAgent?.outcome === b.mainAgent?.outcome &&
    a.mainAgent?.stateStartedAt === b.mainAgent?.stateStartedAt
  )
}
