// Layout-owner builds: where rows one side lists and main's layout does not go in main's groups.
// Both the row writer's reorder and A2's merge place them the same way.

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabGroup } from '../../../shared/runtime-session-contracts'

type Group = RuntimeMobileSessionTabGroup

/** The id a group's tab order lists a row under: a terminal pane's tab, else the row itself. */
export function orderIdOf(row: RuntimeMobileSessionSnapshotTab): string {
  return row.type === 'terminal' ? row.parentTabId : row.id
}

/** Each side-only id placed after the id it follows in the side's group, else at the start. */
export function withWindowOnlyIds(
  tabOrder: readonly string[],
  windowOrder: readonly string[],
  windowOnly: ReadonlySet<string>
): string[] {
  const order = [...tabOrder]
  windowOrder.forEach((id, index) => {
    if (!windowOnly.has(id) || order.includes(id)) {
      return
    }
    const after = windowOrder
      .slice(0, index)
      .toReversed()
      .find((previous) => order.includes(previous))
    order.splice(after === undefined ? 0 : order.indexOf(after) + 1, 0, id)
  })
  return order
}

/**
 * Main's groups, each with the side-only order ids (orderIdOf) the side's group of the same id
 * lists, where they stood there. Ids in a group main lacks, or in no group (in `sideOrder`), come
 * back as `stray` for the caller's active group.
 */
export function placeInMainGroups(
  mainGroups: readonly Group[],
  sideGroups: readonly Group[],
  sideOnly: ReadonlySet<string>,
  sideOrder: readonly string[] = []
): { groups: Group[]; stray: string[] } {
  const side = new Map(sideGroups.map((group) => [group.id, group]))
  const groups = mainGroups.map((group) => ({
    ...group,
    tabOrder: withWindowOnlyIds(group.tabOrder, side.get(group.id)?.tabOrder ?? [], sideOnly)
  }))
  const placed = new Set(groups.flatMap((group) => group.tabOrder))
  const stray = [
    ...new Set([...sideGroups.flatMap((group) => group.tabOrder), ...sideOrder])
  ].filter((id) => sideOnly.has(id) && !placed.has(id))
  return { groups, stray }
}

/** The groups with the stray ids appended to the one at `index`; unchanged when it is absent. */
export function withStrayIn(groups: Group[], stray: readonly string[], index: number): Group[] {
  const target = groups[index]
  if (!target || stray.length === 0) {
    return groups
  }
  return groups.map((group, at) =>
    at === index ? { ...target, tabOrder: [...target.tabOrder, ...stray] } : group
  )
}
