import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/agent-session/view/structured-agent-session-projection'

export type SidebarSessionTab = {
  id: string
  type: string
  parentTabId?: string
  leafId?: string
  sessionId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** Tabs from a session.tabs.list snapshot. Null when the reply is not a tab list. */
export function sidebarSessionTabs(snapshot: unknown): SidebarSessionTab[] | null {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.tabs)) {
    return null
  }
  const tabs: SidebarSessionTab[] = []
  for (const entry of snapshot.tabs) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.type !== 'string') {
      continue
    }
    tabs.push({
      id: entry.id,
      type: entry.type,
      parentTabId: optionalString(entry, 'parentTabId'),
      leafId: optionalString(entry, 'leafId'),
      sessionId: optionalString(entry, 'sessionId')
    })
  }
  return tabs
}

// Same pane match as notificationPaneTab. A child row shares its parent's pane and is not its own tab.
export function sidebarSessionTabForPane(
  tabs: readonly SidebarSessionTab[],
  paneKey: string
): SidebarSessionTab | undefined {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) => {
    if (tab.type === 'terminal') {
      return (tab.parentTabId ?? tab.id) === pane.tabId && tab.leafId === pane.leafId
    }
    if (tab.type !== 'agent-session') {
      return false
    }
    if (tab.id === pane.tabId) {
      return true
    }
    return (
      tab.sessionId !== undefined &&
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(tab.sessionId), tab.sessionId) ===
        paneKey
    )
  })
}
