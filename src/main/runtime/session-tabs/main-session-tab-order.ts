// Take only order/groups from main; preserve written rows and terminal/exit facts that may be newer than layout bindings.

import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { MainSessionTabRows } from './main-session-tab-rows'
import { orderIdOf, placeInMainGroups, withStrayIn } from './main-session-tab-group-placement'
import {
  normalizeMobileSessionTabSelection,
  resolveMobileSessionActiveTab,
  restoreLegacyMobileSessionNavigation,
  selectMobileSessionTab
} from './mobile-session-tab-selection'

/** The written rows, ordered and grouped as main's layout has them. */
export function withMainTabOrder(
  written: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows,
  selected?: RuntimeMobileSessionSnapshotTab
): RuntimeMobileSessionTabsSnapshot {
  const mainGroups = projected.tabGroups ?? []
  if (mainGroups.length === 0 || written.tabs.length === 0) {
    return selected
      ? selectMobileSessionTab(written, selected)
      : normalizeMobileSessionTabSelection(written)
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
  const placedGroups = placement.groups.map((group) => ({
    ...group,
    activeTabId: writtenGroups.get(group.id)?.activeTabId ?? null
  }))
  const activeRow = selected ?? resolveMobileSessionActiveTab(written, written.tabs)
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
  const tabGroups = groups.filter(
    (group) => group.tabOrder.length > 0 || group.id === written.activeGroupId
  )
  const position = new Map(tabGroups.flatMap((group) => group.tabOrder).map((id, at) => [id, at]))
  const tabs = written.tabs
    .map((row, at) => ({ row, at }))
    .toSorted(
      (a, b) =>
        (position.get(orderIdOf(a.row)) ?? position.size) -
          (position.get(orderIdOf(b.row)) ?? position.size) || a.at - b.at
    )
    .map(({ row }) => row)
  const declared =
    written.tabGroups !== undefined
      ? (writtenGroups.get(written.activeGroupId ?? '')?.activeTabId ?? null)
      : written.activeTabId
  const { tabGroupLayout: _writtenLayout, ...rest } = written
  const ordered = {
    ...rest,
    tabGroups,
    ...(projected.tabGroupLayout ? { tabGroupLayout: projected.tabGroupLayout } : {}),
    tabs
  }
  return selected
    ? selectMobileSessionTab(ordered, selected)
    : restoreLegacyMobileSessionNavigation(ordered, {
        ...written,
        tabs: [],
        tabGroups: undefined,
        activeTabId: activeRow?.id ?? declared
      })
}
