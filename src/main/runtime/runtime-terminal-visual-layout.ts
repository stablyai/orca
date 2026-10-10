import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeTerminalSummary,
  RuntimeTerminalVisualGroupNode,
  RuntimeTerminalVisualLayout,
  RuntimeTerminalVisualLayoutNode,
  RuntimeTerminalVisualPaneNode,
  RuntimeTerminalVisualTab
} from '../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'

type RuntimeTerminalVisualLayoutArgs = {
  terminals: RuntimeTerminalSummary[]
  worktreesById: ReadonlyMap<string, { path: string }>
  snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>
  getTabTitle: (tabId: string) => string | null
}

const leafKey = (tabId: string, leafId: string): string => `${tabId}::${leafId}`

export function buildRuntimeTerminalVisualLayouts(
  args: RuntimeTerminalVisualLayoutArgs
): RuntimeTerminalVisualLayout[] {
  if (args.terminals.length === 0) {
    return []
  }
  const summariesByLeafKey = new Map(
    args.terminals.map((terminal) => [leafKey(terminal.tabId, terminal.leafId), terminal])
  )
  const summariesByWorktree = new Map<string, RuntimeTerminalSummary[]>()
  for (const terminal of args.terminals) {
    const existing = summariesByWorktree.get(terminal.worktreeId)
    if (existing) {
      existing.push(terminal)
    } else {
      summariesByWorktree.set(terminal.worktreeId, [terminal])
    }
  }
  const layouts: RuntimeTerminalVisualLayout[] = []
  for (const snapshot of args.snapshots) {
    const worktreeTerminals = summariesByWorktree.get(snapshot.worktree)
    if (!worktreeTerminals?.length) {
      continue
    }
    const groups = buildGroups(snapshot, summariesByLeafKey, args.getTabTitle)
    if (groups.length === 0) {
      continue
    }
    const groupsById = new Map(
      groups
        .filter((group): group is RuntimeTerminalVisualGroupNode & { groupId: string } =>
          Boolean(group.groupId)
        )
        .map((group) => [group.groupId, group])
    )
    const root = buildGroupLayout(snapshot.tabGroupLayout, groupsById) ?? groups[0]
    if (!root) {
      continue
    }
    const worktree = args.worktreesById.get(snapshot.worktree)
    layouts.push({
      worktreeId: snapshot.worktree,
      worktreePath: worktree?.path ?? worktreeTerminals[0]?.worktreePath ?? '',
      root
    })
  }
  return layouts
}

function buildGroups(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>,
  getTabTitle: (tabId: string) => string | null
): RuntimeTerminalVisualGroupNode[] {
  const terminalTabs = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
  )
  if (terminalTabs.length === 0) {
    return []
  }
  const tabsByParentId = new Map<string, RuntimeMobileSessionTerminalTab[]>()
  const parentOrder: string[] = []
  for (const tab of terminalTabs) {
    const existing = tabsByParentId.get(tab.parentTabId)
    if (existing) {
      existing.push(tab)
    } else {
      parentOrder.push(tab.parentTabId)
      tabsByParentId.set(tab.parentTabId, [tab])
    }
  }
  const groupSources = snapshot.tabGroups?.length
    ? snapshot.tabGroups
    : [{ id: null, activeTabId: snapshot.activeTabId, tabOrder: parentOrder }]
  return groupSources
    .map((group): RuntimeTerminalVisualGroupNode | null => {
      const tabs = group.tabOrder
        .map((tabId) => {
          const surfaces =
            tabsByParentId.get(tabId) ?? terminalTabs.filter((tab) => tab.id === tabId)
          return buildTab(tabId, surfaces, summariesByLeafKey, getTabTitle)
        })
        .filter((tab): tab is RuntimeTerminalVisualTab => tab !== null)
      if (tabs.length === 0) {
        return null
      }
      return {
        type: 'group',
        groupId: group.id,
        activeTabId:
          group.activeTabId && tabs.some((tab) => tab.tabId === group.activeTabId)
            ? group.activeTabId
            : (tabs[0]?.tabId ?? null),
        tabs
      }
    })
    .filter((group): group is RuntimeTerminalVisualGroupNode => group !== null)
}

function buildTab(
  tabId: string,
  surfaces: RuntimeMobileSessionTerminalTab[],
  summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>,
  getTabTitle: (tabId: string) => string | null
): RuntimeTerminalVisualTab | null {
  const firstSurface = surfaces[0]
  if (!firstSurface) {
    return null
  }
  const parentTabId = firstSurface.parentTabId
  const requestedActiveLeafId =
    firstSurface.parentLayout?.activeLeafId ??
    surfaces.find((surface) => surface.isActive)?.leafId ??
    firstSurface.leafId
  const root = firstSurface.parentLayout?.root ?? {
    type: 'leaf' as const,
    leafId: firstSurface.leafId
  }
  const visibleLeafIds = collectVisibleLeafIds(root, parentTabId, summariesByLeafKey)
  if (visibleLeafIds.length === 0) {
    return null
  }
  const activeLeafId =
    (requestedActiveLeafId && visibleLeafIds.includes(requestedActiveLeafId)
      ? requestedActiveLeafId
      : surfaces.find((surface) => surface.isActive && visibleLeafIds.includes(surface.leafId))
          ?.leafId) ?? visibleLeafIds[0]!
  const panes = buildPane(root, parentTabId, activeLeafId, summariesByLeafKey)
  if (!panes) {
    return null
  }
  return {
    tabId: parentTabId || tabId,
    title: getTabTitle(parentTabId) ?? firstSurface.title ?? null,
    activeLeafId,
    panes
  }
}

function collectVisibleLeafIds(
  node: TerminalPaneLayoutNode,
  tabId: string,
  summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
): string[] {
  if (node.type === 'leaf') {
    return summariesByLeafKey.has(leafKey(tabId, node.leafId)) ? [node.leafId] : []
  }
  return [
    ...collectVisibleLeafIds(node.first, tabId, summariesByLeafKey),
    ...collectVisibleLeafIds(node.second, tabId, summariesByLeafKey)
  ]
}

function buildPane(
  node: TerminalPaneLayoutNode,
  tabId: string,
  activeLeafId: string | null,
  summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
): RuntimeTerminalVisualPaneNode | null {
  if (node.type === 'leaf') {
    const summary = summariesByLeafKey.get(leafKey(tabId, node.leafId))
    if (!summary) {
      return null
    }
    return {
      type: 'terminal',
      handle: summary.handle,
      tabId: summary.tabId,
      leafId: summary.leafId,
      title: summary.title,
      connected: summary.connected,
      active: summary.leafId === activeLeafId
    }
  }
  const first = buildPane(node.first, tabId, activeLeafId, summariesByLeafKey)
  const second = buildPane(node.second, tabId, activeLeafId, summariesByLeafKey)
  if (first && second) {
    return { type: 'pane-split', direction: node.direction, first, second }
  }
  return first ?? second
}

function buildGroupLayout(
  node: TabGroupLayoutNode | null | undefined,
  groupsById: ReadonlyMap<string, RuntimeTerminalVisualGroupNode>
): RuntimeTerminalVisualLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return groupsById.get(node.groupId) ?? null
  }
  const first = buildGroupLayout(node.first, groupsById)
  const second = buildGroupLayout(node.second, groupsById)
  if (first && second) {
    return { type: 'split', direction: node.direction, first, second }
  }
  return first ?? second
}
