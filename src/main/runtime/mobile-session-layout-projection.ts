import { createHash, randomUUID } from 'node:crypto'
import { isTerminalLeafId } from '../../shared/stable-pane-id'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessTerminalSplitLayout } from './headless-terminal-split-layout'

export function collectPersistedTerminalLeafIds(
  layout: TerminalLayoutSnapshot | undefined
): string[] {
  if (!layout) {
    return []
  }
  const leafIds = new Set<string>()
  const visit = (node: TerminalLayoutSnapshot['root']): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      if (isTerminalLeafId(node.leafId)) {
        leafIds.add(node.leafId)
      }
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout.root)
  if (layout.activeLeafId && isTerminalLeafId(layout.activeLeafId)) {
    leafIds.add(layout.activeLeafId)
  }
  for (const leafId of Object.keys(layout.ptyIdsByLeafId ?? {})) {
    if (isTerminalLeafId(leafId)) {
      leafIds.add(leafId)
    }
  }
  return [...leafIds]
}

export function deriveHeadlessLegacyTerminalLeafId(tabId: string): string {
  const hash = createHash('sha256').update(`headless-terminal-leaf:${tabId}`).digest('hex')
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  const leafId = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32)
  ].join('-')
  if (!isTerminalLeafId(leafId)) {
    return randomUUID()
  }
  return leafId
}

export function cloneTerminalLayoutSnapshot(
  layout: TerminalLayoutSnapshot
): TerminalLayoutSnapshot {
  const cloned: TerminalLayoutSnapshot = {
    root: layout.root,
    activeLeafId: layout.activeLeafId,
    expandedLeafId: layout.expandedLeafId,
    ...(layout.chatLeafId ? { chatLeafId: layout.chatLeafId } : {})
  }
  if (layout.ptyIdsByLeafId) {
    cloned.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
  }
  if (layout.buffersByLeafId) {
    cloned.buffersByLeafId = { ...layout.buffersByLeafId }
  }
  if (layout.scrollbackRefsByLeafId) {
    cloned.scrollbackRefsByLeafId = { ...layout.scrollbackRefsByLeafId }
  }
  if (layout.titlesByLeafId) {
    cloned.titlesByLeafId = { ...layout.titlesByLeafId }
  }
  return cloned
}

export function isPersistedTerminalLeafActive(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  leafId: string,
  layout: TerminalLayoutSnapshot | undefined
): boolean {
  const activeTabId = session.activeTabIdByWorktree?.[worktreeId] ?? session.activeTabId
  return activeTabId === tabId && (!layout?.activeLeafId || layout.activeLeafId === leafId)
}

export function pickHeadlessActiveTerminalTab(
  tabs: readonly RuntimeMobileSessionTerminalTab[]
): RuntimeMobileSessionTerminalTab | null {
  return tabs.find((tab) => tab.isActive) ?? tabs.find((tab) => tab.parentTabId) ?? null
}

export function collectHeadlessParentTabOrder(
  tabs: readonly RuntimeMobileSessionTerminalTab[]
): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const tab of tabs) {
    if (!seen.has(tab.parentTabId)) {
      seen.add(tab.parentTabId)
      order.push(tab.parentTabId)
    }
  }
  return order
}

// Preserve cross-type insertion order; split terminal leaves share parentTabId while browsers use their own id.
export function collectHeadlessTopLevelTabOrder(
  tabs: readonly RuntimeMobileSessionSnapshotTab[]
): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const tab of tabs) {
    const topLevelId = tab.type === 'terminal' ? tab.parentTabId : tab.id
    if (!seen.has(topLevelId)) {
      seen.add(topLevelId)
      order.push(topLevelId)
    }
  }
  return order
}

export function getHeadlessMobileSessionGroupId(worktreeId: string): string {
  return `headless-terminals:${worktreeId}`
}

export function buildHeadlessMobileSessionTabGroups(
  worktreeId: string,
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  activeTab: RuntimeMobileSessionSnapshotTab | null,
  existingGroups?: readonly RuntimeMobileSessionTabGroup[],
  // A group-specific + must target that group, not whichever group is active.
  newTabAssignment?: { tabId: string; groupId: string }
): RuntimeMobileSessionTabGroup[] {
  const arrivalOrder = collectHeadlessTopLevelTabOrder(tabs)
  // Retain stored tab positions; materializing idle surfaces can move their incoming array entries.
  const liveTopLevelIds = new Set(arrivalOrder)
  const tabOrder: string[] = []
  const placed = new Set<string>()
  for (const group of existingGroups ?? []) {
    for (const tabId of group.tabOrder) {
      if (liveTopLevelIds.has(tabId) && !placed.has(tabId)) {
        tabOrder.push(tabId)
        placed.add(tabId)
      }
    }
  }
  for (const tabId of arrivalOrder) {
    if (!placed.has(tabId)) {
      tabOrder.push(tabId)
      placed.add(tabId)
    }
  }
  const topLevelOf = (tab: RuntimeMobileSessionSnapshotTab): string =>
    tab.type === 'terminal' ? tab.parentTabId : tab.id
  const activeTopLevelId =
    (activeTab ? topLevelOf(activeTab) : null) ??
    existingGroups?.[0]?.activeTabId ??
    (() => {
      const active = tabs.find((tab) => tab.isActive)
      return active ? topLevelOf(active) : null
    })() ??
    tabOrder[0] ??
    null

  if (existingGroups && existingGroups.length > 1) {
    return distributeHeadlessTabsAcrossGroups(
      existingGroups,
      tabOrder,
      activeTopLevelId,
      newTabAssignment
    )
  }

  const groupId = existingGroups?.[0]?.id ?? getHeadlessMobileSessionGroupId(worktreeId)
  return [
    {
      id: groupId,
      activeTabId:
        activeTopLevelId && tabOrder.includes(activeTopLevelId)
          ? activeTopLevelId
          : (tabOrder[0] ?? null),
      tabOrder
    }
  ]
}

// Preserve groups across rebuilds, send new tabs to the active group, and drop emptied groups.
export function distributeHeadlessTabsAcrossGroups(
  existingGroups: readonly RuntimeMobileSessionTabGroup[],
  tabOrder: readonly string[],
  activeTopLevelId: string | null,
  newTabAssignment?: { tabId: string; groupId: string }
): RuntimeMobileSessionTabGroup[] {
  const groupIdByTabId = new Map<string, string>()
  for (const group of existingGroups) {
    for (const tabId of group.tabOrder) {
      groupIdByTabId.set(tabId, group.id)
    }
  }
  const hasTargetGroup =
    newTabAssignment !== undefined &&
    existingGroups.some((group) => group.id === newTabAssignment.groupId)
  if (hasTargetGroup) {
    groupIdByTabId.set(newTabAssignment!.tabId, newTabAssignment!.groupId)
  }
  const activeGroupId =
    (activeTopLevelId ? groupIdByTabId.get(activeTopLevelId) : undefined) ?? existingGroups[0]!.id
  const orderByGroup = new Map<string, string[]>(existingGroups.map((group) => [group.id, []]))
  for (const tabId of tabOrder) {
    const groupId = groupIdByTabId.get(tabId) ?? activeGroupId
    orderByGroup.get(groupId)?.push(tabId)
  }
  return existingGroups
    .map((group) => {
      const nextOrder = orderByGroup.get(group.id) ?? []
      return {
        ...group,
        tabOrder: nextOrder,
        activeTabId:
          activeTopLevelId && nextOrder.includes(activeTopLevelId)
            ? activeTopLevelId
            : group.activeTabId && nextOrder.includes(group.activeTabId)
              ? group.activeTabId
              : (nextOrder[0] ?? null)
      }
    })
    .filter((group) => group.tabOrder.length > 0)
}

// Restored splits need an active id from their own groups, never a generated headless id.
export function pickRestoredActiveGroupId(
  groups: readonly RuntimeMobileSessionTabGroup[],
  preferredGroupIds: readonly (string | null | undefined)[],
  activeTopLevelId: string | null
): string | null {
  const groupIds = new Set(groups.map((group) => group.id))
  const preferred = preferredGroupIds.find((id): id is string => id != null && groupIds.has(id))
  return (
    preferred ??
    (activeTopLevelId
      ? groups.find((group) => group.tabOrder.includes(activeTopLevelId))?.id
      : undefined) ??
    groups[0]?.id ??
    null
  )
}

export function buildMaterializedHeadlessParentLayout(
  leafId: string,
  ptyId: string,
  existingLayout: TerminalLayoutSnapshot | undefined,
  split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
): TerminalLayoutSnapshot {
  if (!existingLayout) {
    return {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    }
  }
  // Insert into the live tree with the requested direction; otherwise published splits use the fallback orientation.
  if (split) {
    return buildHeadlessTerminalSplitLayout(cloneTerminalLayoutSnapshot(existingLayout), {
      leafId,
      ptyId,
      splitFromLeafId: split.splitFromLeafId,
      direction: split.direction
    })
  }
  return {
    ...cloneTerminalLayoutSnapshot(existingLayout),
    ptyIdsByLeafId: {
      ...existingLayout.ptyIdsByLeafId,
      [leafId]: ptyId
    }
  }
}
