import type { RuntimeMobileSessionTabGroup } from '../../shared/runtime-types'

// Terminal-only rebuilds drop browser ids; restore their prior group, assigning only new browsers to target/first group.
export function appendBrowserTabOrder(
  groups: readonly RuntimeMobileSessionTabGroup[],
  browserTabIds: readonly string[],
  newTabAssignment?: { tabId: string; groupId: string },
  // Carry browser ownership across terminal-only tabOrder rebuilds.
  priorGroupByBrowserId?: ReadonlyMap<string, string>
): RuntimeMobileSessionTabGroup[] {
  if (browserTabIds.length === 0) {
    return [...groups]
  }
  const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
  if (next.length === 0) {
    return next
  }
  const groupById = new Map(next.map((group) => [group.id, group]))
  const ownerGroupByTabId = new Map<string, RuntimeMobileSessionTabGroup>()
  for (const group of next) {
    for (const id of group.tabOrder) {
      ownerGroupByTabId.set(id, group)
    }
  }
  for (const id of browserTabIds) {
    if (ownerGroupByTabId.has(id)) {
      continue
    }
    const priorGroupId = priorGroupByBrowserId?.get(id)
    const targetGroup =
      (newTabAssignment?.tabId === id ? groupById.get(newTabAssignment.groupId) : undefined) ??
      (priorGroupId ? groupById.get(priorGroupId) : undefined) ??
      next[0]!
    targetGroup.tabOrder.push(id)
  }
  return next
}

export function collectBrowserGroupAssignment(
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  browserTabIds: readonly string[]
): Map<string, string> {
  const browserIdSet = new Set(browserTabIds)
  const assignment = new Map<string, string>()
  for (const group of groups ?? []) {
    for (const id of group.tabOrder) {
      if (browserIdSet.has(id)) {
        assignment.set(id, group.id)
      }
    }
  }
  return assignment
}
