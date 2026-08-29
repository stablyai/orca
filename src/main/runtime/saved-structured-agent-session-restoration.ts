import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

function savedSessionId(tab: Tab): string | null {
  if (tab.executionHostId && tab.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  if (tab.agentSessionAgent === 'claude') {
    return null
  }
  return tab.structuredSessionId ?? (tab.contentType === 'agent-session' ? tab.entityId : null)
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
