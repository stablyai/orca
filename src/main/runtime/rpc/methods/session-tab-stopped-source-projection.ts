import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { withoutSessionTabs } from './session-tab-browser-placement-projection'

/**
 * A phone has no stopped state for a pane a switch stopped and kept, so it sees that pane gone, as
 * when a terminal exits; its selection falls back as it does then. Paired desktops keep the row and
 * show the stopped pane from main's fact. A tab whose every pane stopped leaves the phone's tab
 * order too, and returns with its row when the fact dies (Restart, or a retry's replacement chat).
 */
export function projectSessionTabStoppedSources(
  payload: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined
): RuntimeMobileSessionTabsResult {
  if (clientKind !== 'mobile') {
    return payload
  }
  let stoppedRowIds: Set<string> | null = null
  const stoppedTabIds = new Set<string>()
  for (const tab of payload.tabs) {
    if (tab.type === 'terminal' && tab.stoppedSwitchSource) {
      stoppedRowIds ??= new Set()
      stoppedRowIds.add(tab.id)
      stoppedTabIds.add(tab.parentTabId)
    }
  }
  if (!stoppedRowIds) {
    return payload
  }
  for (const tab of payload.tabs) {
    if (tab.type === 'terminal' && !stoppedRowIds.has(tab.id)) {
      stoppedTabIds.delete(tab.parentTabId)
    }
  }
  return withoutSessionTabs(payload, new Set([...stoppedRowIds, ...stoppedTabIds]))
}
