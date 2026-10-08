import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  collectTabGroupLayoutGroupIds,
  replaceTabGroupLayoutLeaf
} from './headless-tab-group-split-layout'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import { pruneTabGroupLayoutAfterRetirement } from './mobile-session-terminal-retirement'

/** Maps between the ids a snapshot shows and the wrapper ids persisted group orders hold. */
export type SnapshotTabIdTranslation = {
  /** The persisted wrapper id, or null for a tab nothing may persist (a diff, an unwrapped chat). */
  toWrapperId(snapshotTabId: string): string | null
  toSnapshotId(wrapperId: string): string
}

function findWrapper(
  wrappers: readonly Tab[],
  tab: RuntimeMobileSessionSnapshotTab
): Tab | undefined {
  switch (tab.type) {
    case 'terminal':
      return wrappers.find(
        (wrapper) =>
          wrapper.contentType === 'terminal' &&
          (wrapper.id === tab.parentTabId || wrapper.entityId === tab.parentTabId)
      )
    case 'browser':
      return wrappers.find(
        (wrapper) =>
          wrapper.contentType === 'browser' &&
          (wrapper.id === tab.id ||
            wrapper.entityId === tab.id ||
            wrapper.entityId === tab.browserWorkspaceId)
      )
    case 'agent-session':
      // Why: a reopened chat's wrapper id is not derivable from its session, and a /clear-replaced
      // chat's wrapper still names the session it replaced until a window rewrites it.
      return (
        wrappers.find(
          (wrapper) =>
            wrapper.contentType === 'agent-session' &&
            (wrapper.entityId === tab.sessionId ||
              wrapper.id === structuredAgentSessionTabId(tab.sessionId))
        ) ??
        (tab.replacesSessionId
          ? wrappers.find(
              (wrapper) =>
                wrapper.contentType === 'agent-session' &&
                wrapper.entityId === tab.replacesSessionId
            )
          : undefined)
      )
    case 'markdown':
    case 'file':
      // Why: editor ids come from the session's own rows, not from wrapper matching.
      return undefined
  }
}

export function translateSnapshotTabIds(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  wrappers: readonly Tab[],
  editorWrapperIdBySnapshotId: ReadonlyMap<string, string>
): SnapshotTabIdTranslation {
  const wrapperIdBySnapshotId = new Map<string, string | null>()
  for (const tab of tabs) {
    if (tab.type === 'markdown' || tab.type === 'file') {
      wrapperIdBySnapshotId.set(tab.id, editorWrapperIdBySnapshotId.get(tab.id) ?? null)
      continue
    }
    const topLevelId = tab.type === 'terminal' ? tab.parentTabId : tab.id
    if (wrapperIdBySnapshotId.has(topLevelId)) {
      continue
    }
    // Why: an unwrapped terminal or page keeps its own id, as the headless layout writer stores it.
    const fallback = tab.type === 'agent-session' ? null : topLevelId
    wrapperIdBySnapshotId.set(topLevelId, findWrapper(wrappers, tab)?.id ?? fallback)
  }
  const snapshotIdByWrapperId = new Map<string, string>()
  for (const [snapshotId, wrapperId] of wrapperIdBySnapshotId) {
    if (wrapperId !== null && !snapshotIdByWrapperId.has(wrapperId)) {
      snapshotIdByWrapperId.set(wrapperId, snapshotId)
    }
  }
  return {
    toWrapperId: (snapshotTabId) => wrapperIdBySnapshotId.get(snapshotTabId) ?? null,
    toSnapshotId: (wrapperId) => snapshotIdByWrapperId.get(wrapperId) ?? wrapperId
  }
}

/** Each persisted group's members as a window restores them: a wrapper's own group wins. */
function persistedGroupMembers(
  groups: readonly TabGroup[],
  wrappers: readonly Tab[]
): Map<string, string[]> {
  const groupIds = new Set(groups.map((group) => group.id))
  const wrapperIds = new Set(wrappers.map((wrapper) => wrapper.id))
  const ownerByWrapperId = new Map<string, string>()
  for (const wrapper of wrappers) {
    if (groupIds.has(wrapper.groupId)) {
      ownerByWrapperId.set(wrapper.id, wrapper.groupId)
    }
  }
  for (const group of groups) {
    for (const tabId of group.tabOrder) {
      if (wrapperIds.has(tabId) && !ownerByWrapperId.has(tabId)) {
        ownerByWrapperId.set(tabId, group.id)
      }
    }
  }
  const members = new Map(groups.map((group) => [group.id, new Set<string>()]))
  for (const group of groups) {
    for (const tabId of group.tabOrder) {
      if (ownerByWrapperId.get(tabId) === group.id) {
        members.get(group.id)!.add(tabId)
      }
    }
  }
  for (const wrapper of wrappers) {
    // Why: hydration appends a declared member its order omits and adopts a groupless one first.
    members.get(ownerByWrapperId.get(wrapper.id) ?? groups[0]!.id)!.add(wrapper.id)
  }
  return new Map([...members].map(([groupId, ids]) => [groupId, [...ids]]))
}

/** The group's new visible order, with each member the snapshot hid kept after the same neighbour. */
function mergeVisibleOrder(
  before: readonly string[],
  after: readonly string[],
  visible: ReadonlySet<string>
): string[] {
  const afterIds = new Set(after)
  const leading: string[] = []
  const trailingByAnchor = new Map<string, string[]>()
  let anchor: string | null = null
  for (const tabId of before) {
    if (afterIds.has(tabId)) {
      anchor = tabId
    } else if (!visible.has(tabId)) {
      if (anchor === null) {
        leading.push(tabId)
      } else {
        trailingByAnchor.set(anchor, [...(trailingByAnchor.get(anchor) ?? []), tabId])
      }
    }
  }
  return [...leading, ...after.flatMap((tabId) => [tabId, ...(trailingByAnchor.get(tabId) ?? [])])]
}

/** Places a group the snapshot added (a split) beside the neighbour it was split from. */
function graftGroupLeaf(
  layout: TabGroupLayoutNode,
  groupId: string,
  snapshotLayout: TabGroupLayoutNode | undefined
): TabGroupLayoutNode {
  const placed = collectTabGroupLayoutGroupIds(layout)
  const findSplit = (node: TabGroupLayoutNode): TabGroupLayoutNode | null => {
    if (node.type === 'leaf') {
      return null
    }
    const hasLeaf = (child: TabGroupLayoutNode) =>
      child.type === 'leaf' && child.groupId === groupId
    if (hasLeaf(node.first) || hasLeaf(node.second)) {
      return node
    }
    return findSplit(node.first) ?? findSplit(node.second)
  }
  const split = snapshotLayout ? findSplit(snapshotLayout) : null
  const leaf: TabGroupLayoutNode = { type: 'leaf', groupId }
  if (split?.type === 'split') {
    const newFirst = split.first.type === 'leaf' && split.first.groupId === groupId
    const sibling = newFirst ? split.second : split.first
    const anchor = [...collectTabGroupLayoutGroupIds(sibling)].find((id) => placed.has(id))
    if (anchor) {
      const anchorLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: anchor }
      return replaceTabGroupLayoutLeaf(layout, anchor, {
        ...split,
        first: newFirst ? leaf : anchorLeaf,
        second: newFirst ? anchorLeaf : leaf
      })
    }
  }
  return { type: 'split', direction: 'horizontal', ratio: 0.5, first: layout, second: leaf }
}

/**
 * Applies a headless move to a unified session as an edit of its persisted groups. The snapshot
 * shows only what the host can render, so members and groups it could not show (a chat, a closed
 * browser page, a hidden row) keep their place, and a group goes only when it is truly empty.
 * Returns null when the session has no persisted groups for the worktree to edit.
 */
export function editPersistedTabGroups(
  session: WorkspaceSessionState,
  worktreeId: string,
  snapshot: Pick<
    RuntimeMobileSessionTabsSnapshot,
    'tabGroups' | 'tabGroupLayout' | 'activeGroupId'
  >,
  translation: SnapshotTabIdTranslation
): WorkspaceSessionState | null {
  const persisted = session.tabGroups?.[worktreeId] ?? []
  if (persisted.length === 0) {
    return null
  }
  const wrappers = session.unifiedTabs?.[worktreeId] ?? []
  const membersByGroupId = persistedGroupMembers(persisted, wrappers)
  const shown = (snapshot.tabGroups ?? []).map((group) => ({
    group,
    order: [
      ...new Set(
        group.tabOrder
          .map(translation.toWrapperId)
          .filter((tabId): tabId is string => tabId !== null)
      )
    ]
  }))
  const persistedById = new Map(persisted.map((group) => [group.id, group]))
  // Why: a persisted synthetic group is an ordinary group, but the host never invents one here.
  if (
    shown.some(
      (entry) =>
        entry.group.id === getHeadlessMobileSessionGroupId(worktreeId) &&
        !persistedById.has(entry.group.id)
    )
  ) {
    return null
  }
  const shownById = new Map(shown.map((entry) => [entry.group.id, entry]))
  const visible = new Set(shown.flatMap((entry) => entry.order))
  const groupIds = [
    ...persisted.map((group) => group.id),
    ...shown.map((entry) => entry.group.id).filter((groupId) => !persistedById.has(groupId))
  ]
  const edited: TabGroup[] = groupIds.map((groupId) => {
    const previous = persistedById.get(groupId)
    const next = shownById.get(groupId)
    const before = membersByGroupId.get(groupId) ?? []
    const tabOrder = next
      ? mergeVisibleOrder(before, next.order, visible)
      : before.filter((tabId) => !visible.has(tabId))
    const members = new Set(tabOrder)
    const shownActive = next?.group.activeTabId
      ? translation.toWrapperId(next.group.activeTabId)
      : null
    const shownRecent = next?.group.recentTabIds
      ?.map(translation.toWrapperId)
      .filter((tabId): tabId is string => tabId !== null)
    const recent = shownRecent
      ? [
          ...(previous?.recentTabIds ?? []).filter((id) => !shownRecent.includes(id)),
          ...shownRecent
        ]
      : previous?.recentTabIds
    return {
      id: groupId,
      worktreeId,
      activeTabId:
        [shownActive, previous?.activeTabId].find((id) => id && members.has(id)) ??
        tabOrder[0] ??
        null,
      tabOrder,
      ...(recent ? { recentTabIds: [...new Set(recent)].filter((id) => members.has(id)) } : {})
    }
  })
  const nonEmpty = edited.filter((group) => group.tabOrder.length > 0)
  const groups = nonEmpty.length > 0 ? nonEmpty : edited.slice(0, 1)
  const groupIdSet = new Set(groups.map((group) => group.id))

  const snapshotLayout = snapshot.tabGroupLayout ?? undefined
  let layout: TabGroupLayoutNode = pruneTabGroupLayoutAfterRetirement(
    session.tabGroupLayouts?.[worktreeId],
    groupIdSet
  ) ??
    pruneTabGroupLayoutAfterRetirement(snapshotLayout, groupIdSet) ?? {
      type: 'leaf',
      groupId: groups[0]!.id
    }
  for (const group of groups) {
    if (!collectTabGroupLayoutGroupIds(layout).has(group.id)) {
      layout = graftGroupLeaf(layout, group.id, snapshotLayout)
    }
  }

  // Why every member: a window orders a group by sortOrder too, so hidden siblings are renumbered.
  const placement = new Map<string, { groupId: string; sortOrder: number }>()
  for (const group of groups) {
    group.tabOrder.forEach((tabId, sortOrder) =>
      placement.set(tabId, { groupId: group.id, sortOrder })
    )
  }
  const nextWrappers = wrappers.map((wrapper) => {
    const place = placement.get(wrapper.id)
    return place && (place.groupId !== wrapper.groupId || place.sortOrder !== wrapper.sortOrder)
      ? { ...wrapper, ...place }
      : wrapper
  })
  const activeGroupId = [
    snapshot.activeGroupId,
    session.activeGroupIdByWorktree?.[worktreeId]
  ].find((groupId): groupId is string => Boolean(groupId && groupIdSet.has(groupId)))
  return {
    ...session,
    unifiedTabs: { ...session.unifiedTabs, [worktreeId]: nextWrappers },
    tabGroups: { ...session.tabGroups, [worktreeId]: groups },
    tabGroupLayouts: { ...session.tabGroupLayouts, [worktreeId]: layout },
    activeGroupIdByWorktree: {
      ...session.activeGroupIdByWorktree,
      [worktreeId]: activeGroupId ?? groups[0]!.id
    }
  }
}
