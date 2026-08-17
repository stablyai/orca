import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { LayoutNode } from './herdr-socket-types'
import {
  DEFAULT_RATIO,
  type CreatePaneOptions,
  type ModelPane,
  type ModelTab,
  type ModelWorkspace
} from './herdr-daemon-model-types'
import {
  applyLayoutToTab,
  firstPaneId,
  removeLeaf,
  replaceLeaf,
  setRatioOnSplitContaining
} from './herdr-daemon-layout'

// Why: the domain model the daemon serves protocol-19 snapshots and layout trees
// from: sessions own workspaces, tabs own a binary layout tree of panes and splits.
// Idempotent ensure-by-label matches the stock herdr workspace/tab semantics.
export class HerdrDaemonModel {
  readonly workspaces = new Map<string, ModelWorkspace>()
  readonly tabs = new Map<string, ModelTab>()
  readonly panes = new Map<string, ModelPane>()
  private readonly workspaceByLabel = new Map<string, string>()
  private readonly tabByLabel = new Map<string, string>()
  private workspaceCounter = 0
  private tabCounter = 0
  private paneCounter = 0

  constructor(readonly sessionName: string) {}

  nextPaneId(): string {
    return `p${++this.paneCounter}`
  }

  restoreWorkspace(workspace: ModelWorkspace): void {
    this.workspaces.set(workspace.workspace_id, workspace)
    this.workspaceByLabel.set(workspace.label, workspace.workspace_id)
  }

  restoreTab(tab: ModelTab): void {
    this.tabs.set(tab.tab_id, tab)
    this.tabByLabel.set(`${tab.workspace_id}:${tab.label}`, tab.tab_id)
  }

  restorePane(pane: ModelPane): void {
    this.panes.set(pane.pane_id, pane)
  }

  restoreCounters(workspace: number, tab: number, pane: number): void {
    this.workspaceCounter = workspace
    this.tabCounter = tab
    this.paneCounter = pane
  }

  getCounters(): { workspace: number; tab: number; pane: number } {
    return { workspace: this.workspaceCounter, tab: this.tabCounter, pane: this.paneCounter }
  }

  ensureWorkspace(
    label: string,
    options: { tokens?: Record<string, string>; worktree?: { checkout_path: string } } = {}
  ): ModelWorkspace {
    const existingId = this.workspaceByLabel.get(label)
    if (existingId !== undefined) {
      const existing = this.workspaces.get(existingId)
      if (existing) {
        return existing
      }
    }
    const workspaceId = `w${++this.workspaceCounter}`
    const workspace: ModelWorkspace = {
      workspace_id: workspaceId,
      label,
      tokens: options.tokens,
      worktree: options.worktree
    }
    this.workspaces.set(workspaceId, workspace)
    this.workspaceByLabel.set(label, workspaceId)
    return workspace
  }

  ensureTab(workspaceId: string, label: string): ModelTab {
    this.requireWorkspace(workspaceId)
    const scopedLabel = `${workspaceId}:${label}`
    const existingId = this.tabByLabel.get(scopedLabel)
    if (existingId !== undefined) {
      const existing = this.tabs.get(existingId)
      if (existing && existing.workspace_id === workspaceId) {
        return existing
      }
    }
    const tabId = `t${++this.tabCounter}`
    const tab: ModelTab = {
      tab_id: tabId,
      workspace_id: workspaceId,
      label,
      root: { kind: 'pane', pane_id: '' },
      focused_pane_id: null,
      zoomed: false
    }
    this.tabs.set(tabId, tab)
    this.tabByLabel.set(`${workspaceId}:${label}`, tabId)
    return tab
  }

  createPane(
    workspaceId: string,
    tabId: string,
    options: CreatePaneOptions
  ): { pane_id: string; workspace_id: string; tab_id: string } {
    this.requireWorkspace(workspaceId)
    const tab = this.requireTab(tabId)
    if (tab.root.kind === 'pane' && tab.root.pane_id) {
      throw new HerdrRuntimeError('tab_not_empty', `Tab ${tabId} already holds a pane`)
    }
    const paneId = `p${++this.paneCounter}`
    const pane: ModelPane = {
      pane_id: paneId,
      tab_id: tabId,
      workspace_id: workspaceId,
      cwd: options.cwd,
      label: options.label,
      revision: 0,
      agent: options.agent ?? null,
      agent_status: 'idle'
    }
    this.panes.set(paneId, pane)
    tab.root = { kind: 'pane', pane_id: paneId }
    tab.focused_pane_id = paneId
    return { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId }
  }

  splitPane(
    paneId: string,
    direction: 'right' | 'down',
    ratio = DEFAULT_RATIO,
    options: CreatePaneOptions
  ): { pane_id: string } {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(pane.tab_id)
    const newPaneId = `p${++this.paneCounter}`
    const created: ModelPane = {
      pane_id: newPaneId,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
      cwd: options.cwd,
      label: options.label,
      revision: 0,
      agent: options.agent ?? null,
      agent_status: 'idle'
    }
    this.panes.set(newPaneId, created)
    tab.root = replaceLeaf(tab.root, paneId, {
      kind: 'split',
      direction,
      ratio,
      first: { kind: 'pane', pane_id: paneId },
      second: { kind: 'pane', pane_id: newPaneId }
    })
    tab.focused_pane_id = newPaneId
    return { pane_id: newPaneId }
  }

  closePane(paneId: string): void {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(pane.tab_id)
    this.panes.delete(paneId)
    tab.root = removeLeaf(tab.root, paneId)
    if (tab.root.kind === 'pane' && !tab.root.pane_id) {
      this.tabs.delete(tab.tab_id)
      this.tabByLabel.delete(`${tab.workspace_id}:${tab.label}`)
      return
    }
    if (tab.focused_pane_id === paneId) {
      tab.focused_pane_id = firstPaneId(tab.root)
    }
  }

  detachPane(paneId: string): {
    previous_tab_id: string
    previous_workspace_id: string
    closed_tab_id: string | null
    closed_workspace_id: string | null
  } {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(pane.tab_id)
    const previousTabId = tab.tab_id
    const previousWorkspaceId = tab.workspace_id
    tab.root = removeLeaf(tab.root, paneId)
    let closedTabId: string | null = null
    let closedWorkspaceId: string | null = null
    if (tab.root.kind === 'pane' && !tab.root.pane_id) {
      this.tabs.delete(tab.tab_id)
      this.tabByLabel.delete(`${tab.workspace_id}:${tab.label}`)
      closedTabId = tab.tab_id
      const hasTabs = [...this.tabs.values()].some((t) => t.workspace_id === previousWorkspaceId)
      if (!hasTabs) {
        const ws = this.workspaces.get(previousWorkspaceId)
        if (ws) {
          this.workspaceByLabel.delete(ws.label)
          this.workspaces.delete(previousWorkspaceId)
        }
        closedWorkspaceId = previousWorkspaceId
      }
    } else if (tab.focused_pane_id === paneId) {
      tab.focused_pane_id = firstPaneId(tab.root)
    }
    return {
      previous_tab_id: previousTabId,
      previous_workspace_id: previousWorkspaceId,
      closed_tab_id: closedTabId,
      closed_workspace_id: closedWorkspaceId
    }
  }

  attachPaneToTab(paneId: string, workspaceId: string, tabId: string): void {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(tabId)
    pane.workspace_id = workspaceId
    pane.tab_id = tabId
    tab.root = { kind: 'pane', pane_id: paneId }
    tab.focused_pane_id = paneId
  }

  attachPaneAsSplit(
    paneId: string,
    targetPaneId: string,
    direction: 'right' | 'down',
    ratio: number
  ): void {
    const pane = this.requirePane(paneId)
    const target = this.requirePane(targetPaneId)
    const tab = this.requireTab(target.tab_id)
    pane.workspace_id = target.workspace_id
    pane.tab_id = target.tab_id
    tab.root = replaceLeaf(tab.root, targetPaneId, {
      kind: 'split',
      direction,
      ratio,
      first: { kind: 'pane', pane_id: targetPaneId },
      second: { kind: 'pane', pane_id: paneId }
    })
    tab.focused_pane_id = paneId
  }

  closeWorkspace(workspaceId: string): void {
    this.requireWorkspace(workspaceId)
    for (const pane of this.panes.values()) {
      if (pane.workspace_id === workspaceId) {
        this.closePane(pane.pane_id)
      }
    }
    const workspace = this.workspaces.get(workspaceId)
    if (workspace) {
      this.workspaceByLabel.delete(workspace.label)
      this.workspaces.delete(workspaceId)
    }
  }

  bumpPaneRevision(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (pane) {
      pane.revision += 1
    }
  }

  focusPane(paneId: string): void {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(pane.tab_id)
    tab.focused_pane_id = paneId
    const modelPane = this.panes.get(paneId)
    if (modelPane) {
      modelPane.revision += 1
    }
  }

  focusTab(tabId: string): void {
    const tab = this.requireTab(tabId)
    const paneId = firstPaneId(tab.root)
    if (paneId) {
      tab.focused_pane_id = paneId
    }
  }

  renameWorkspace(workspaceId: string, label: string): void {
    const workspace = this.requireWorkspace(workspaceId)
    for (const [existingLabel, id] of this.workspaceByLabel) {
      if (id === workspaceId) {
        this.workspaceByLabel.delete(existingLabel)
        break
      }
    }
    workspace.label = label
    this.workspaceByLabel.set(label, workspaceId)
  }

  renameTab(tabId: string, label: string): void {
    const tab = this.requireTab(tabId)
    const scopedKey = `${tab.workspace_id}:${tab.label}`
    if (this.tabByLabel.get(scopedKey) === tabId) {
      this.tabByLabel.delete(scopedKey)
    }
    tab.label = label
    this.tabByLabel.set(`${tab.workspace_id}:${label}`, tabId)
  }

  renamePane(paneId: string, label: string): void {
    const pane = this.requirePane(paneId)
    pane.label = label
    pane.revision += 1
  }

  setPaneAgent(paneId: string, agent: string | null): void {
    const pane = this.requirePane(paneId)
    pane.agent = agent
    pane.revision += 1
  }

  setPaneTokens(paneId: string, tokens: Record<string, string>): void {
    const pane = this.requirePane(paneId)
    pane.tokens = { ...pane.tokens, ...tokens }
    pane.revision += 1
    // Why: an orca_binding token must have a single owner. Stale runs can leave
    // the same leaf bound to two panes; the latest report wins and the older
    // holder must drop the token, or binding lookups become ambiguous forever.
    // Ownership is per token value — different leaves coexist under the same key.
    for (const [key, value] of Object.entries(tokens)) {
      for (const candidate of this.panes.values()) {
        if (candidate.pane_id !== paneId && candidate.tokens?.[key] === value) {
          delete candidate.tokens[key]
          candidate.revision += 1
        }
      }
    }
  }

  setPaneAgentStatus(paneId: string, status: ModelPane['agent_status']): void {
    const pane = this.requirePane(paneId)
    pane.agent_status = status
    pane.revision += 1
  }

  setPaneZoomed(paneId: string, zoomed: boolean): void {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(pane.tab_id)
    tab.zoomed = zoomed
    pane.revision += 1
  }

  applyLayout(workspaceId: string, tabId: string, root: LayoutNode, defaultCwd: string): string[] {
    this.requireWorkspace(workspaceId)
    const tab = this.requireTab(tabId)
    return applyLayoutToTab({
      panes: this.panes,
      tab,
      workspaceId,
      root,
      defaultCwd,
      nextPaneId: () => `p${++this.paneCounter}`
    })
  }

  setSplitRatio(paneId: string, ratio: number): boolean {
    const pane = this.requirePane(paneId)
    const tab = this.requireTab(pane.tab_id)
    const changed = setRatioOnSplitContaining(tab.root, paneId, ratio)
    if (!changed) {
      throw new HerdrRuntimeError('split_not_found', `Pane ${paneId} has no split to resize`)
    }
    return true
  }

  setSplitRatioByPath(tabId: string, path: boolean[], ratio: number): boolean {
    const tab = this.requireTab(tabId)
    let node = tab.root
    for (const goSecond of path) {
      if (node.kind === 'pane') {
        return false
      }
      node = goSecond ? node.second : node.first
    }
    if (node.kind === 'pane') {
      return false
    }
    node.ratio = ratio
    return true
  }

  getPane(paneId: string): ModelPane | undefined {
    return this.panes.get(paneId)
  }

  getTab(tabId: string): ModelTab | undefined {
    return this.tabs.get(tabId)
  }

  getWorkspace(workspaceId: string): ModelWorkspace | undefined {
    return this.workspaces.get(workspaceId)
  }

  getWorkspaceByLabel(label: string): ModelWorkspace | undefined {
    const workspaceId = this.workspaceByLabel.get(label)
    return workspaceId !== undefined ? this.workspaces.get(workspaceId) : undefined
  }

  listWorkspaces(): ModelWorkspace[] {
    return [...this.workspaces.values()]
  }

  listTabs(): ModelTab[] {
    return [...this.tabs.values()]
  }

  listPanes(): ModelPane[] {
    return [...this.panes.values()]
  }

  requireWorkspace(workspaceId: string): ModelWorkspace {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) {
      throw new HerdrRuntimeError('workspace_not_found', `Workspace ${workspaceId} not found`)
    }
    return workspace
  }

  requireTab(tabId: string): ModelTab {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      throw new HerdrRuntimeError('tab_not_found', `Tab ${tabId} not found`)
    }
    return tab
  }

  requirePane(paneId: string): ModelPane {
    const pane = this.panes.get(paneId)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${paneId} not found`)
    }
    return pane
  }

  reorderWorkspaces(order: string[]): void {
    const entries = order.map(
      (key) => [key, this.workspaces.get(key)] as [string, ModelWorkspace | undefined]
    )
    this.workspaces.clear()
    for (const [key, value] of entries) {
      if (value) {
        this.workspaces.set(key, value)
      }
    }
  }

  reorderTabsInWorkspace(workspaceId: string, reordered: ModelTab[]): void {
    const reorderedIds = new Set(reordered.map((tab) => tab.tab_id))
    const result: ModelTab[] = []
    for (const tab of this.tabs.values()) {
      if (tab.workspace_id === workspaceId && reorderedIds.has(tab.tab_id)) {
        continue
      }
      result.push(tab)
    }
    let inserted = false
    for (const tab of this.tabs.values()) {
      if (tab.workspace_id === workspaceId && !inserted) {
        result.push(...reordered)
        inserted = true
      }
    }
    this.tabs.clear()
    this.tabByLabel.clear()
    for (const tab of result) {
      this.tabs.set(tab.tab_id, tab)
      this.tabByLabel.set(`${tab.workspace_id}:${tab.label}`, tab.tab_id)
    }
  }

  deleteTabEntry(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      return
    }
    this.tabs.delete(tabId)
    this.tabByLabel.delete(`${tab.workspace_id}:${tab.label}`)
  }
}
