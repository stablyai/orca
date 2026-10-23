/**
 * The browser tabs a move carried that the window open across it saved over. The host lists no
 * browser tab of this desktop, so that window's mirror of the host's tabs dropped them. They are
 * added back beside what the window saved, never in place of it: a tab, file or terminal the user
 * opened there since stays as it is.
 */
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/** `existing` with the carried browser tabs it lacks for `workspaceIds`; null when none. */
export function withWslMoveEchoedBrowserTabs(
  existing: WorkspaceSessionState,
  carried: WorkspaceSessionState,
  workspaceIds: ReadonlySet<string>
): WorkspaceSessionState | null {
  const next = structuredClone(existing)
  let changed = false
  for (const workspaceId of workspaceIds) {
    const held = new Set((next.browserTabsByWorktree?.[workspaceId] ?? []).map((tab) => tab.id))
    const groups = next.tabGroups?.[workspaceId] ?? []
    for (const browserTab of carried.browserTabsByWorktree?.[workspaceId] ?? []) {
      if (held.has(browserTab.id)) {
        continue
      }
      const carriedTab = carried.unifiedTabs?.[workspaceId]?.find(
        (tab) => tab.contentType === 'browser' && tab.entityId === browserTab.id
      )
      const heldTabs = next.unifiedTabs?.[workspaceId] ?? []
      if (carriedTab && heldTabs.some((tab) => tab.id === carriedTab.id)) {
        continue
      }
      // The carried group if the window kept it, else the active one: the tab must sit in a group.
      const group =
        groups.find((entry) => entry.id === carriedTab?.groupId) ??
        groups.find((entry) => entry.id === next.activeGroupIdByWorktree?.[workspaceId]) ??
        groups[0]
      if (carriedTab && !group) {
        continue
      }
      next.browserTabsByWorktree = {
        ...next.browserTabsByWorktree,
        [workspaceId]: [...(next.browserTabsByWorktree?.[workspaceId] ?? []), browserTab]
      }
      const pages = carried.browserPagesByWorkspace?.[browserTab.id]
      if (pages && !next.browserPagesByWorkspace?.[browserTab.id]) {
        next.browserPagesByWorkspace = { ...next.browserPagesByWorkspace, [browserTab.id]: pages }
      }
      if (carriedTab && group) {
        next.unifiedTabs = {
          ...next.unifiedTabs,
          [workspaceId]: [...heldTabs, { ...carriedTab, groupId: group.id }]
        }
        group.tabOrder = [...group.tabOrder, carriedTab.id]
      }
      changed = true
    }
  }
  return changed ? next : null
}
