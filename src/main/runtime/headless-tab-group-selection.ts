// The headless host's per-group selected tab, kept beside the shared group moves, which hold only
// order and membership: the moved tab is selected where it lands; elsewhere a group keeps its
// selection while that tab stays, else selects its first tab.

import type { RuntimeMobileSessionTabGroup } from '../../shared/runtime-types'
import type { LayoutGroup } from '../../shared/workspace-layout/workspace-layout-model'

export function withSelectedTabs(
  before: readonly RuntimeMobileSessionTabGroup[],
  after: readonly LayoutGroup[],
  movedTabId: string
): RuntimeMobileSessionTabGroup[] {
  return after.map((group) => {
    const previous = before.find((candidate) => candidate.id === group.id)
    const kept = previous?.activeTabId
    const activeTabId = group.tabOrder.includes(movedTabId)
      ? movedTabId
      : kept && group.tabOrder.includes(kept)
        ? kept
        : (group.tabOrder[0] ?? null)
    return { ...previous, id: group.id, tabOrder: group.tabOrder, activeTabId }
  })
}
