import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { ModelWorkspace } from './herdr-daemon-model-types'
import { swapLeaves } from './herdr-daemon-layout-geometry'
import { leafInTree } from './herdr-daemon-layout'
import type { HerdrDaemonModel } from './herdr-daemon-model'

// Why: high-level workspace/tab/pane operations built on the model's public
// state. Kept apart from the model so the mutable core stays small and the
// operations read as a sequence of state transitions.

export function moveWorkspace(
  model: HerdrDaemonModel,
  workspaceId: string,
  insertIndex: number
): void {
  model.requireWorkspace(workspaceId)
  const ordered = [...model.workspaces.keys()]
  const from = ordered.indexOf(workspaceId)
  ordered.splice(from, 1)
  ordered.splice(Math.max(0, Math.min(insertIndex, ordered.length)), 0, workspaceId)
  model.reorderWorkspaces(ordered)
}

export function moveWorkspaceBlock(
  model: HerdrDaemonModel,
  workspaceIds: string[],
  beforeWorkspaceId: string | null
): void {
  for (const id of workspaceIds) {
    model.requireWorkspace(id)
  }
  if (beforeWorkspaceId) {
    model.requireWorkspace(beforeWorkspaceId)
  }
  const block = new Set(workspaceIds)
  const ordered = [...model.workspaces.keys()].filter((id) => !block.has(id))
  const insertAt = beforeWorkspaceId ? ordered.indexOf(beforeWorkspaceId) : ordered.length
  if (insertAt < 0) {
    return
  }
  ordered.splice(insertAt, 0, ...workspaceIds)
  model.reorderWorkspaces(ordered)
}

export function moveTab(model: HerdrDaemonModel, tabId: string, insertIndex: number): void {
  const tab = model.requireTab(tabId)
  const workspaceId = tab.workspace_id
  const wsTabs = [...model.tabs.values()].filter(
    (candidate) => candidate.workspace_id === workspaceId
  )
  const from = wsTabs.findIndex((candidate) => candidate.tab_id === tabId)
  const moved = wsTabs.splice(from, 1)[0]
  wsTabs.splice(Math.max(0, Math.min(insertIndex, wsTabs.length)), 0, moved)
  model.reorderTabsInWorkspace(workspaceId, wsTabs)
}

export function closeTab(model: HerdrDaemonModel, tabId: string): void {
  model.requireTab(tabId)
  for (const pane of model.panes.values()) {
    if (pane.tab_id === tabId) {
      model.closePane(pane.pane_id)
    }
  }
  if (model.tabs.has(tabId)) {
    model.deleteTabEntry(tabId)
  }
}

export function swapPanes(model: HerdrDaemonModel, paneIdA: string, paneIdB: string): void {
  model.requirePane(paneIdA)
  model.requirePane(paneIdB)
  if (paneIdA === paneIdB) {
    return
  }
  const paneA = model.requirePane(paneIdA)
  const tab = model.requireTab(paneA.tab_id)
  if (tab.root.kind === 'pane' || !leafInTree(tab.root, paneIdB)) {
    throw new HerdrRuntimeError('pane_not_found', `Pane ${paneIdB} is not in tab ${tab.tab_id}`)
  }
  tab.root = swapLeaves(tab.root, paneIdA, paneIdB)
  model.requirePane(paneIdA).revision += 1
  model.requirePane(paneIdB).revision += 1
}

export function setWorkspaceMetadata(
  model: HerdrDaemonModel,
  workspaceId: string,
  source: string,
  tokens?: Record<string, string>
): void {
  const workspace = model.requireWorkspace(workspaceId)
  workspace.metadata_source = source
  if (tokens) {
    workspace.tokens = { ...workspace.tokens, ...tokens }
  }
}

export function setWorkspaceWorktree(
  model: HerdrDaemonModel,
  workspaceId: string,
  worktree: ModelWorkspace['worktree']
): void {
  const workspace = model.requireWorkspace(workspaceId)
  workspace.worktree = worktree
}
