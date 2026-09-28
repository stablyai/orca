import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup
} from '../../shared/runtime-types'
import {
  collectRecentTabIdsFromGroups,
  pickMostRecentSurvivingTabId,
  pickNextTabAfterClose
} from '../../shared/session-tab-close-successor'

export function topLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

export function chooseActiveSurface(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  previousActiveId: string | null,
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  previousActiveGroupId: string | null,
  recentTabIds?: readonly string[]
): RuntimeMobileSessionSnapshotTab | null {
  // Why: keep a surviving active surface first — the previous tab when it lives,
  // otherwise a surviving pane of the retired active terminal (split terminal).
  const preserved =
    (previousActiveId ? tabs.find((tab) => tab.id === previousActiveId) : undefined) ??
    tabs.find((tab) => tab.isActive)
  if (preserved) {
    return preserved
  }
  // Why: the visit history (global first, per-group merge for older snapshots)
  // outranks the repaired group selection, so retiring the active tab cannot
  // resurrect an older group sibling over a newer cross-group visit.
  const history = recentTabIds ?? collectRecentTabIdsFromGroups(groups)
  const recentId = pickMostRecentSurvivingTabId({
    remainingTabIds: tabs.map(topLevelTabId),
    closingTabId: previousActiveId ?? '',
    recentTabIds: history
  })
  const activeGroup = previousActiveGroupId
    ? groups?.find((group) => group.id === previousActiveGroupId)
    : groups?.[0]
  const activeTopLevelId = activeGroup?.activeTabId
  return (
    (recentId ? tabs.find((tab) => topLevelTabId(tab) === recentId) : undefined) ??
    (activeTopLevelId ? tabs.find((tab) => topLevelTabId(tab) === activeTopLevelId) : undefined) ??
    pickNextTabAfterClose(tabs, previousActiveId ?? '', history, topLevelTabId)
  )
}
