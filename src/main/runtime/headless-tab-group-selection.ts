// Preserve per-group selection across shared membership moves; removed selections fall back to the first tab.

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
