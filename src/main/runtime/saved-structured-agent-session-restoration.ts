import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  getActiveSidebarWorkspaceId,
  normalizeWorkspaceSessionKeyToWorkspaceId
} from '../../shared/workspace-scope'
import type { StructuredAgentSessionStartupPriority } from '../native-chat/agent-session-wire/structured-agent-session-restart-restore'

function savedSessionId(tab: Tab): string | null {
  if (tab.executionHostId && tab.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  if (tab.agentSessionAgent === 'claude') {
    return null
  }
  return tab.contentType === 'agent-session' ? tab.entityId : null
}

/** Visible chats restore first; closed historical journals stay lazy. */
export function collectSavedStructuredAgentSessionIds(
  session: WorkspaceSessionState | null
): string[] {
  const tabs = Object.values(session?.unifiedTabs ?? {}).flat()
  const activeTabIds = new Set(
    Object.values(session?.activeTabIdByWorktree ?? {}).filter(
      (tabId): tabId is string => typeof tabId === 'string'
    )
  )
  const selected: string[] = []
  const seen = new Set<string>()
  const add = (tab: Tab): void => {
    const sessionId = savedSessionId(tab)
    if (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId)
      selected.push(sessionId)
    }
  }
  for (const tab of tabs) {
    if (activeTabIds.has(tab.id)) {
      add(tab)
    }
  }
  for (const tab of tabs) {
    add(tab)
  }
  return selected
}

/** Which workspaces the startup pass reaches first: the one the window last showed, then any with
 *  a saved tab. Null without a saved desktop session (`orca serve`, SSH), keeping listing order. */
export function structuredAgentSessionStartupPriority(
  session: WorkspaceSessionState | null
): StructuredAgentSessionStartupPriority | undefined {
  if (!session) {
    return undefined
  }
  const withTabs = [
    ...Object.keys(session.unifiedTabs ?? {}),
    ...Object.keys(session.tabsByWorktree ?? {})
  ].map(normalizeWorkspaceSessionKeyToWorkspaceId)
  return {
    activeWorkspaceId: getActiveSidebarWorkspaceId(
      session.activeWorkspaceKey ?? null,
      session.activeWorktreeId
    ),
    visibleWorkspaceIds: new Set(withTabs)
  }
}
