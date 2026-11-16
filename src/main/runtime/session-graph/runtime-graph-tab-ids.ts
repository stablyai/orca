import type { RuntimeSyncedTab } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** The runtime indexes graph tabs by bare id, so duplicate ids cannot be routed safely. */
export function assertUniqueRuntimeGraphTabIds(tabs: readonly RuntimeSyncedTab[]): void {
  const seen = new Set<string>()
  for (const tab of tabs) {
    if (seen.has(tab.tabId)) {
      throw new Error('duplicate_runtime_tab_id')
    }
    seen.add(tab.tabId)
  }
}
