import type {
  HerdrPane,
  HerdrPaneLayoutSnapshot,
  HerdrSessionSnapshot
} from './herdr-runtime-contract'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { HerdrPaneLayoutRect, LayoutNode } from './herdr-socket-types'
import type { HerdrDaemonModel } from './herdr-daemon-model'
import { DEFAULT_AREA, type ModelPane, type ModelTab } from './herdr-daemon-model-types'
import { firstPaneId, layoutNodeFromTree, layoutRects, splitRects } from './herdr-daemon-layout'

// Why: snapshot/export are read-only projections of the model state. They live
// apart from the model so the mutable core stays small and the projections stay
// pure functions of the current tree.

export function herdrExportLayout(model: HerdrDaemonModel, tabId: string): LayoutNode {
  const tab = requireTab(model, tabId)
  const panes = paneLookup(model)
  return layoutNodeFromTree(tab.root, panes)
}

export function herdrLayoutSnapshot(
  model: HerdrDaemonModel,
  tabId: string,
  area: HerdrPaneLayoutRect = DEFAULT_AREA
): HerdrPaneLayoutSnapshot {
  const tab = requireTab(model, tabId)
  const panes = paneLookup(model)
  return {
    workspace_id: tab.workspace_id,
    tab_id: tab.tab_id,
    panes: layoutRects(tab.root, area, panes),
    area,
    focused_pane_id: tab.focused_pane_id ?? firstPaneId(tab.root) ?? undefined,
    splits: splitRects(tab.root, area),
    zoomed: tab.zoomed
  }
}

export function herdrSessionSnapshot(
  model: HerdrDaemonModel,
  protocol: number
): HerdrSessionSnapshot {
  const workspaces = model.listWorkspaces()
  const tabs = model.listTabs()
  const panes = model.listPanes().map((pane): HerdrPane => {
    const record: HerdrPane = {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
      cwd: pane.cwd,
      label: pane.label,
      tokens: pane.tokens,
      agent: pane.agent,
      agent_status: pane.agent_status,
      revision: pane.revision
    }
    return record
  })
  return {
    version: '0.1.0-daemon',
    protocol,
    workspaces: workspaces.map((workspace) => ({
      workspace_id: workspace.workspace_id,
      label: workspace.label,
      tokens: workspace.tokens,
      worktree: workspace.worktree
    })),
    tabs: tabs.map((tab) => ({
      tab_id: tab.tab_id,
      workspace_id: tab.workspace_id,
      label: tab.label
    })),
    panes,
    layouts: tabs.map((tab) => herdrLayoutSnapshot(model, tab.tab_id)),
    agents: []
  }
}

function paneLookup(model: HerdrDaemonModel): Map<string, ModelPane> {
  const lookup = new Map<string, ModelPane>()
  for (const pane of model.listPanes()) {
    lookup.set(pane.pane_id, pane)
  }
  return lookup
}

function requireTab(model: HerdrDaemonModel, tabId: string): ModelTab {
  const tab = model.getTab(tabId)
  if (!tab) {
    throw new HerdrRuntimeError('tab_not_found', `Tab ${tabId} not found`)
  }
  return tab
}
