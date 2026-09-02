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
    expandedLeafId: layout.expandedLeafId
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

// Why: the group tab order must follow actual creation/insertion order across
// both terminals and browsers, not list terminals first. A terminal's top-level
// id is its parentTabId (split leaves share one); a browser's is its own id.
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
  // Why: a new tab created via a specific group's "+" must land in THAT group,
  // not the active one — otherwise every "+" in a split funnels to one group.
  newTabAssignment?: { tabId: string; groupId: string }
): RuntimeMobileSessionTabGroup[] {
  // Why: order across terminals and browsers in their actual array order so a
  // tab opened after a browser tab lands to its right, not regrouped before it.
  const arrivalOrder = collectHeadlessTopLevelTabOrder(tabs)
  // Why: tabOrder is the user-visible order and must survive a republish. A
  // materialized idle surface can move to the end of the incoming array, so
  // retain stored positions and append only genuinely new ids.
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

  // Why: when the user has split tabs into multiple groups, preserve that
  // assignment across rebuilds instead of coalescing back to one group.
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

// Distribute live top-level tabs into the existing multi-group structure,
// keeping each tab in its group; tabs new since the last snapshot join the
// active group. Emptied groups are dropped so a closed split collapses.
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
  // Why: route a freshly-created tab to the group its "+" was clicked in,
  // when that group still exists; otherwise fall through to the active group.
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
  // Why: a split must insert the new leaf into the live layout tree with the
  // requested direction, or the published snapshot keeps the old single-leaf
  // root and the split renders with a fallback direction ("Split Right" lands
  // as a top/bottom split). Reuse the persisted-split builder for parity.
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
