import type {
  RecoveryAgentBinding,
  RecoveryLayout,
  RecoveryTab,
  RecoveryTabGroup,
  RecoveryTerminalTab
} from '../../../shared/cross-machine-recovery-descriptor'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'

/** Host bindings win over view structure: each bound terminal gets its host row and a group slot. */
export function withHostBindingTabs(
  view: RecoveryLayout,
  host: RecoveryLayout,
  bindings: readonly RecoveryAgentBinding[]
): RecoveryLayout {
  let next = view
  for (const binding of bindings) {
    const hostTab = host.terminalTabs.find((tab) => tab.id === binding.sourceTabId)
    if (!hostTab) {
      continue
    }
    next = next.terminalTabs.some((tab) => tab.id === hostTab.id)
      ? withHostBoundLeaf(next, host, hostTab.id, binding.sourceLeafId)
      : withHostTerminalRow(next, host, hostTab)
    next = withPlacedTerminalTab(next, host, hostTab)
  }
  return next
}

// Why: a stale view that lost the bound leaf would strand its binding; the host's panes win.
function withHostBoundLeaf(
  layout: RecoveryLayout,
  host: RecoveryLayout,
  tabId: string,
  leafId: string | null
): RecoveryLayout {
  const hostLayout = host.terminalLayouts[tabId]
  if (
    !leafId ||
    !hostLayout ||
    leafBelongsToTab(layout.terminalLayouts, tabId, leafId) ||
    !leafBelongsToTab(host.terminalLayouts, tabId, leafId)
  ) {
    return layout
  }
  return { ...layout, terminalLayouts: { ...layout.terminalLayouts, [tabId]: hostLayout } }
}

function withHostTerminalRow(
  layout: RecoveryLayout,
  host: RecoveryLayout,
  hostTab: RecoveryTerminalTab
): RecoveryLayout {
  const hostLayout = host.terminalLayouts[hostTab.id]
  const hostCwd = host.startupCwdRelative[hostTab.id]
  return {
    ...layout,
    terminalTabs: [...layout.terminalTabs, hostTab],
    terminalLayouts: hostLayout
      ? { ...layout.terminalLayouts, [hostTab.id]: hostLayout }
      : layout.terminalLayouts,
    startupCwdRelative:
      hostCwd === undefined
        ? layout.startupCwdRelative
        : { ...layout.startupCwdRelative, [hostTab.id]: hostCwd }
  }
}

// Why: reconciliation drops a terminal row no group lists, stranding its dormant binding.
function withPlacedTerminalTab(
  layout: RecoveryLayout,
  host: RecoveryLayout,
  terminal: RecoveryTerminalTab
): RecoveryLayout {
  const isTerminal = (tab: RecoveryTab): boolean =>
    tab.contentType === 'terminal' && tab.entityId === terminal.id
  const current = layout.tabs.find(isTerminal)
  if (
    current &&
    layout.groups.some(
      (group) => group.id === current.groupId && group.tabOrder.includes(current.id)
    )
  ) {
    return layout
  }
  const placed = current ?? host.tabs.find(isTerminal)
  const target =
    layout.groups.find((group) => group.id === placed?.groupId) ??
    layout.groups.find((group) => group.id === layout.activeGroupId) ??
    layout.groups[0]
  // Why: host-admitted spawns persist a terminal row with no unified tab or group at all;
  // the synthesized group's source id only keys the remap, which mints the local id.
  const groupId = target?.id ?? placed?.groupId ?? terminal.id
  const tab = placed ?? unifiedTerminalTab(terminal, groupId)
  const next = target
    ? layout
    : withDestinationGroup(layout, {
        id: groupId,
        activeTabId: host.groups.find((group) => group.id === groupId)?.activeTabId ?? tab.id,
        tabOrder: []
      })
  return {
    ...next,
    tabs: [...next.tabs.filter((candidate) => candidate !== current), { ...tab, groupId }],
    groups: next.groups.map((group) => {
      const tabOrder = group.tabOrder.filter((id) => id !== tab.id)
      return { ...group, tabOrder: group.id === groupId ? [...tabOrder, tab.id] : tabOrder }
    })
  }
}

function unifiedTerminalTab(terminal: RecoveryTerminalTab, groupId: string): RecoveryTab {
  return {
    id: terminal.id,
    entityId: terminal.id,
    groupId,
    contentType: 'terminal',
    label: terminal.title,
    ...(terminal.quickCommandLabel?.trim()
      ? { quickCommandLabel: terminal.quickCommandLabel.trim() }
      : {}),
    ...(terminal.generatedTitle?.trim() ? { generatedLabel: terminal.generatedTitle.trim() } : {}),
    ...(terminal.aiVaultTitle ? { aiVaultTitle: terminal.aiVaultTitle } : {}),
    customLabel: terminal.customTitle,
    color: terminal.color,
    sortOrder: terminal.sortOrder,
    createdAt: terminal.createdAt
  }
}

// Why: a view with no groups would strand host tabs, since every unified tab needs a group slot.
function withDestinationGroup(layout: RecoveryLayout, group: RecoveryTabGroup): RecoveryLayout {
  return {
    ...layout,
    groups: [...layout.groups, group],
    groupLayout: { type: 'leaf', groupId: group.id },
    activeGroupId: group.id
  }
}

export function leafBelongsToTab(
  layouts: Readonly<Record<string, { root: TerminalPaneLayoutNode | null }>>,
  tabId: string,
  leafId: string
): boolean {
  const stack: (TerminalPaneLayoutNode | null | undefined)[] = [layouts[tabId]?.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node?.type === 'leaf' && node.leafId === leafId) {
      return true
    }
    if (node?.type === 'split') {
      stack.push(node.first, node.second)
    }
  }
  return false
}
