import type { RuntimeSyncedTab } from '../../../shared/runtime-session-contracts'

export function syncTabCustomTitles(
  tabs: readonly RuntimeSyncedTab[],
  previousTabs: ReadonlyMap<string, RuntimeSyncedTab>,
  rememberTitle: (tabId: string, title: string | null) => void
): void {
  for (const tab of tabs) {
    const customTitle = tab.customTitle?.trim() || null
    const previousCustomTitle = previousTabs.get(tab.tabId)?.customTitle?.trim() || null
    if (customTitle) {
      rememberTitle(tab.tabId, customTitle)
    } else if (previousCustomTitle) {
      rememberTitle(tab.tabId, null)
    }
  }
}
