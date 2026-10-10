import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import type { MobileSessionTab } from './mobile-session-route-types'

/**
 * The tab a notification's pane key names, or nothing when that pane has since closed.
 *
 * Its own module because both siblings of the navigation hook read it, and a web sibling cannot
 * import its native neighbour by name: the bundler's `resolveExtensions` answers
 * `./use-notification-pane-navigation` with the `.web.ts` file, so that import is the file itself.
 */
export function notificationPaneTab(tabs: readonly MobileSessionTab[], paneKey: string) {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) =>
    tab.type === 'terminal'
      ? (tab.parentTabId ?? tab.id) === pane.tabId && tab.leafId === pane.leafId
      : tab.type === 'agent-session' && tab.id === pane.tabId
  )
}
