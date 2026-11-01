// Take only order/groups from main; preserve written rows and terminal/exit facts that may be newer than layout bindings.

import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { MainSessionTabRows } from './main-session-tab-rows'
import { orderIdOf, placeInMainGroups, withStrayIn } from './main-session-tab-group-placement'

/** The written rows, ordered and grouped as main's layout has them. */
export function withMainTabOrder(
  written: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows
): RuntimeMobileSessionTabsSnapshot {
  const mainGroups = projected.tabGroups ?? []
  if (mainGroups.length === 0 || written.tabs.length === 0) {
    return written
  }
  const writtenOrder = [...new Set(written.tabs.map(orderIdOf))]
  const writtenIds = new Set(writtenOrder)
  const mainPlaced = new Set(mainGroups.flatMap((group) => group.tabOrder))
  const writtenOnly = new Set(writtenOrder.filter((id) => !mainPlaced.has(id)))
  const writtenGroups = new Map((written.tabGroups ?? []).map((group) => [group.id, group]))
  const placement = placeInMainGroups(
    mainGroups.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((id) => writtenIds.has(id))
    })),
    written.tabGroups ?? [],
    writtenOnly,
    writtenOrder
  )
  const placedGroups = placement.groups.map((group) => {
    const own = writtenGroups.get(group.id)
    // The written view's selection in the group stands while the group still lists it.
    const activeTabId =
      [own?.activeTabId, group.activeTabId].find((id) => !!id && group.tabOrder.includes(id)) ??
      group.tabOrder[0] ??
      null
    return { ...group, activeTabId }
  })
  const activeRow = written.tabs.find((row) => row.id === written.activeTabId)
  const indexOf = (groupId: string | null): number =>
    placedGroups.findIndex((group) => group.id === groupId)
  const byRow = activeRow
    ? placedGroups.findIndex((group) => group.tabOrder.includes(orderIdOf(activeRow)))
    : -1
  const byWritten = indexOf(written.activeGroupId)
  const activeIndex =
    byRow !== -1
      ? byRow
      : byWritten !== -1
        ? byWritten
        : Math.max(indexOf(projected.activeGroupId), 0)
  // A written row in a group main does not hold joins the active group: groups are main's.
  const groups = withStrayIn(placedGroups, placement.stray, activeIndex)
  const tabGroups = groups.filter((group) => group.tabOrder.length > 0)
  const position = new Map(tabGroups.flatMap((group) => group.tabOrder).map((id, at) => [id, at]))
  const tabs = written.tabs
    .map((row, at) => ({ row, at }))
    .toSorted(
      (a, b) =>
        (position.get(orderIdOf(a.row)) ?? position.size) -
          (position.get(orderIdOf(b.row)) ?? position.size) || a.at - b.at
    )
    .map(({ row }) => row)
  const activeGroupId = groups[activeIndex]?.id ?? null
  const { tabGroupLayout: _writtenLayout, ...rest } = written
  return {
    ...rest,
    activeGroupId: tabGroups.some((group) => group.id === activeGroupId)
      ? activeGroupId
      : (tabGroups[0]?.id ?? written.activeGroupId),
    tabGroups,
    ...(projected.tabGroupLayout ? { tabGroupLayout: projected.tabGroupLayout } : {}),
    tabs
  }
}
