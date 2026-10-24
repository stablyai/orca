import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import type { MobileSessionTab } from './mobile-session-route-types'

/**
 * The tab a notification's pane key names, or nothing when that pane has since closed.
 *
 * Its own module because both siblings of the navigation hook read it, and a web sibling cannot
 * import its native neighbour by name: the bundler's `resolveExtensions` answers
 * `./use-notification-pane-navigation` with the `.web.ts` file, so that import is the file itself.
 */
function splitTerminalTabId(id: string): { parentTabId: string; leafId: string } | null {
  const index = id.indexOf('::')
  if (index <= 0 || index + 2 >= id.length) {
    return null
  }
  return {
    parentTabId: id.slice(0, index),
    leafId: id.slice(index + 2)
  }
}

export function notificationPaneTab(tabs: readonly MobileSessionTab[], paneKey: string) {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) => {
    if (tab.type === 'terminal') {
      if (tab.agentStatus?.paneKey === paneKey) {
        return true
      }
      const split = splitTerminalTabId(tab.id)
      const tabId = tab.parentTabId ?? split?.parentTabId ?? tab.id
      const leafId = tab.leafId ?? split?.leafId
      return tabId === pane.tabId && (leafId === undefined || leafId === pane.leafId)
    }
    if (tab.type === 'agent-session') {
      const expectedPaneKey = structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(tab.sessionId),
        tab.sessionId
      )
      return (
        tab.id === pane.tabId ||
        expectedPaneKey === paneKey ||
        expectedPaneKey.endsWith(`:${pane.leafId}`)
      )
    }
    return false
  })
}

export function sessionTabPaneKey(tab: MobileSessionTab | undefined): string | undefined {
  if (!tab) {
    return undefined
  }
  if (tab.type === 'terminal') {
    if (tab.agentStatus?.paneKey) {
      return tab.agentStatus.paneKey
    }
    const split = splitTerminalTabId(tab.id)
    const tabId = tab.parentTabId ?? split?.parentTabId ?? tab.id
    const leafId = tab.leafId ?? split?.leafId
    return tabId && leafId ? `${tabId}:${leafId}` : `terminal:${tab.id}`
  }
  if (tab.type === 'agent-session') {
    return structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(tab.sessionId),
      tab.sessionId
    )
  }
  return `${tab.type}:${tab.id}`
}
