import { makePaneKey, parsePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { MobileSessionTab } from './mobile-session-tabs'

// Keep native/web navigation’s pane lookup separate: importing the native sibling by name on web resolves back to the web file itself.
export function notificationPaneTab(tabs: readonly MobileSessionTab[], paneKey: string) {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) =>
    tab.type === 'terminal'
      ? (tab.parentTabId ?? tab.id) === pane.tabId && tab.leafId === pane.leafId
      : tab.type === 'agent-session' &&
        (tab.id === pane.tabId ||
          structuredAgentSessionPaneKey(
            structuredAgentSessionTabId(tab.sessionId),
            tab.sessionId
          ) === paneKey)
  )
}

// The pane key that opens this tab again; notificationPaneTab finds the tab from it.
export function mobileSessionTabPaneKey(
  tab: MobileSessionTab | null | undefined
): string | undefined {
  if (tab?.type === 'agent-session') {
    return structuredAgentSessionPaneKey(structuredAgentSessionTabId(tab.sessionId), tab.sessionId)
  }
  if (tab?.type !== 'terminal' || !tab.leafId) {
    return undefined
  }
  try {
    return makePaneKey(tab.parentTabId ?? tab.id, tab.leafId)
  } catch {
    // An id the pane key grammar refuses opens the session on its current tab instead.
    return undefined
  }
}
