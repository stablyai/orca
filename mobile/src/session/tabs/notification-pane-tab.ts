import { parsePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'
import type { MobileSessionTab } from './mobile-session-tabs'
import { chatPaneKey } from '../../../../src/shared/agent-session/view/structured-agent-session-projection'

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
        (tab.id === pane.tabId || chatPaneKey(tab.sessionId) === paneKey)
  )
}
