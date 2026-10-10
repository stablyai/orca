import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export function leafIds(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf' ? [node.leafId] : [...leafIds(node.first), ...leafIds(node.second)]
}

export function withoutLeaf(
  node: TerminalPaneLayoutNode,
  leafId: string
): TerminalPaneLayoutNode | null {
  if (node.type === 'leaf') {
    return node.leafId === leafId ? null : node
  }
  const first = withoutLeaf(node.first, leafId)
  const second = withoutLeaf(node.second, leafId)
  if (!first || !second) {
    return first ?? second
  }
  return { ...node, first, second }
}

export /** The desktop window's copy of the session: it authors tabs and layouts and saves them whole. */
class WindowSession {
  constructor(public session: WorkspaceSessionState) {}

  addTab(worktreeId: string, tabId: string, leafId: string): void {
    const tabs = this.session.tabsByWorktree[worktreeId] ?? []
    const tab: TerminalTab = {
      id: tabId,
      ptyId: null,
      worktreeId,
      title: `Terminal ${tabs.length + 1}`,
      customTitle: null,
      color: null,
      sortOrder: tabs.length,
      createdAt: 1
    }
    this.session.tabsByWorktree = { ...this.session.tabsByWorktree, [worktreeId]: [...tabs, tab] }
    this.setLayout(tabId, { type: 'leaf', leafId }, {})
    this.addTabBarEntry(worktreeId, tabId)
  }

  /** The window's tab bar: one group per worktree, new tabs appended to it. */
  addTabBarEntry(worktreeId: string, tabId: string): void {
    const groupId = `group-${worktreeId}`
    const entry: Tab = {
      id: tabId,
      entityId: tabId,
      groupId,
      worktreeId,
      contentType: 'terminal',
      label: tabId,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const unified = this.session.unifiedTabs ?? {}
    const group = this.session.tabGroups?.[worktreeId]?.[0] ?? {
      id: groupId,
      worktreeId,
      activeTabId: null,
      tabOrder: []
    }
    this.session.unifiedTabs = {
      ...unified,
      [worktreeId]: [...(unified[worktreeId] ?? []), entry]
    }
    this.session.tabGroups = {
      ...this.session.tabGroups,
      [worktreeId]: [{ ...group, activeTabId: tabId, tabOrder: [...group.tabOrder, tabId] }]
    }
  }

  setLayout(tabId: string, root: TerminalPaneLayoutNode, ptyIdsByLeafId: Record<string, string>) {
    this.session.terminalLayoutsByTabId = {
      ...this.session.terminalLayoutsByTabId,
      [tabId]: {
        root,
        activeLeafId: leafIds(root)[0] ?? null,
        expandedLeafId: null,
        ptyIdsByLeafId
      }
    }
  }

  bind(tabId: string, leafId: string, ptyId: string): void {
    const layout = this.session.terminalLayoutsByTabId[tabId]
    if (layout?.root) {
      this.setLayout(tabId, layout.root, { ...layout.ptyIdsByLeafId, [leafId]: ptyId })
    }
    this.setTabPtyId(tabId, ptyId)
  }

  /** `clearTabPtyId` on exit: the tab's live id goes; the layout keeps the binding as a resume hint. */
  setTabPtyId(tabId: string, ptyId: string | null): void {
    this.session.tabsByWorktree = Object.fromEntries(
      Object.entries(this.session.tabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.map((tab) => (tab.id === tabId ? { ...tab, ptyId } : tab))
      ])
    )
  }

  removeTab(tabId: string): void {
    this.session.tabsByWorktree = Object.fromEntries(
      Object.entries(this.session.tabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.filter((tab) => tab.id !== tabId)
      ])
    )
    this.session.unifiedTabs = Object.fromEntries(
      Object.entries(this.session.unifiedTabs ?? {}).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.filter((tab) => tab.id !== tabId)
      ])
    )
    this.session.tabGroups = Object.fromEntries(
      Object.entries(this.session.tabGroups ?? {}).map(([worktreeId, groups]) => [
        worktreeId,
        groups.map((group) => ({
          ...group,
          tabOrder: group.tabOrder.filter((id) => id !== tabId)
        }))
      ])
    )
    const { [tabId]: _removed, ...layouts } = this.session.terminalLayoutsByTabId
    void _removed
    this.session.terminalLayoutsByTabId = layouts
    this.setSleeping(
      Object.fromEntries(
        Object.entries(this.session.sleepingAgentSessionsByPaneKey ?? {}).filter(
          ([paneKey]) => !paneKey.startsWith(`${tabId}:`)
        )
      )
    )
  }

  setSleeping(records: Record<string, SleepingAgentSessionRecord>): void {
    this.session.sleepingAgentSessionsByPaneKey = records
  }

  snapshot(): WorkspaceSessionState {
    return structuredClone(this.session)
  }
}
