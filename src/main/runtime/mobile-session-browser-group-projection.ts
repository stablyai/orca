import type { RuntimeMobileSessionTabGroup } from '../../shared/runtime-types'

// Why: browser session tabs have no parentTabId so the terminal-only group
// builder drops them from tabOrder; this re-adds their ids to a group.
// Browser tabs are live-only (no persisted session entry), but their GROUP
// membership must still survive snapshot rebuilds like terminals'. The
// passed-in groups already encode each browser's group (carried from the prior
// snapshot / persisted tabGroups), so keep each existing browser id where it
// is; only a genuinely-new browser id goes to its create-target group (when
// that group exists) and otherwise to the first group. Previously every
// browser was force-pushed into group[0], so opening a browser in the right
// split group always snapped it back to the left on the next rebuild.
export function appendBrowserTabOrder(
  groups: readonly RuntimeMobileSessionTabGroup[],
  browserTabIds: readonly string[],
  newTabAssignment?: { tabId: string; groupId: string },
  // browserPageId -> groupId from the prior/persisted groups. The terminal
  // distributor rebuilds tabOrder from terminal ids only and drops browser
  // ids, so this carries each browser's group across rebuilds.
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

// browserPageId -> groupId from a set of groups (the persisted/prior layout),
// so a browser stays in its group across rebuilds that drop browser ids.
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
