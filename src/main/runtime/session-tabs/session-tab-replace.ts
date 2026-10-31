import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'

type ReplacementRow = RuntimeMobileSessionTerminalTab | RuntimeMobileSessionAgentTab

/** A tab-bar entry's rows: a chat's one row, or every pane row of a terminal tab. */
function rowsOfTab(snapshot: RuntimeMobileSessionTabsSnapshot, tabId: string) {
  return snapshot.tabs.filter(
    (row) => row.id === tabId || (row.type === 'terminal' && row.parentTabId === tabId)
  )
}

function tabBarIdOf(row: ReplacementRow): string {
  return row.type === 'terminal' ? row.parentTabId : row.id
}

/**
 * One snapshot write for a same-slot switch: the new row takes the replaced tab's place in its
 * group and the replaced tab's rows leave. A replaced tab no group lists degrades to an append at
 * the end of the active group; a tab this snapshot never knew gets no hint either.
 */
export function replaceSessionTabInSnapshot(
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  input: { workspaceId: string; replacedTabId: string; row: ReplacementRow; activate: boolean }
): RuntimeMobileSessionTabsSnapshot {
  const { replacedTabId } = input
  const replaced = new Set(existing ? rowsOfTab(existing, replacedTabId).map((row) => row.id) : [])
  const groups = existing?.tabGroups ?? [
    { id: getHeadlessMobileSessionGroupId(input.workspaceId), activeTabId: null, tabOrder: [] }
  ]
  const slot = groups.find((group) => group.tabOrder.includes(replacedTabId))
  // Decided in this write: the new row takes the selection only from a tab that still holds its
  // group's; with no slot here to read, the request's own choice stands.
  const held = slot?.activeTabId
  const activate =
    input.activate && (!slot || (held != null && (held === replacedTabId || replaced.has(held))))
  // The hint names a tab this snapshot knew; a client that still shows it puts the row there.
  const row: ReplacementRow = {
    ...input.row,
    ...(slot || replaced.size > 0 ? { replaces: { tabId: replacedTabId } } : {}),
    isActive: activate
  }
  const newId = tabBarIdOf(row)
  const tabs = [
    ...(existing?.tabs ?? [])
      .filter((candidate) => !replaced.has(candidate.id) && candidate.id !== row.id)
      .map((candidate) => (activate ? { ...candidate, isActive: false } : candidate)),
    row
  ]
  const targetId =
    slot?.id ?? groups.find((group) => group.id === existing?.activeGroupId)?.id ?? groups[0]!.id
  const tabGroups = groups.map((group) => {
    if (group.id !== targetId) {
      return group
    }
    const tabOrder = group.tabOrder.filter((id) => id !== newId)
    const at = slot ? tabOrder.indexOf(replacedTabId) : -1
    if (at >= 0) {
      tabOrder.splice(at, 1, newId)
    } else {
      tabOrder.push(newId)
    }
    return { ...group, tabOrder, activeTabId: activate ? row.id : group.activeTabId }
  })
  return {
    ...existing,
    worktree: input.workspaceId,
    publicationEpoch: existing?.publicationEpoch ?? `headless:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    activeGroupId: activate ? targetId : (existing?.activeGroupId ?? targetId),
    activeTabId: activate ? row.id : (existing?.activeTabId ?? null),
    activeTabType: activate ? row.type : (existing?.activeTabType ?? null),
    tabGroups,
    tabs
  }
}
