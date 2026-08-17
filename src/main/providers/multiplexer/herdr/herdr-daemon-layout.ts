import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { HerdrPaneLayoutRect, LayoutNode } from './herdr-socket-types'
import {
  DEFAULT_RATIO,
  type LayoutTree,
  type ModelPane,
  type ModelTab
} from './herdr-daemon-model-types'

export function replaceLeaf(tree: LayoutTree, paneId: string, replacement: LayoutTree): LayoutTree {
  if (tree.kind === 'pane') {
    return tree.pane_id === paneId ? replacement : tree
  }
  return {
    ...tree,
    first: replaceLeaf(tree.first, paneId, replacement),
    second: replaceLeaf(tree.second, paneId, replacement)
  }
}

export function removeLeaf(tree: LayoutTree, paneId: string): LayoutTree {
  if (tree.kind === 'pane') {
    return tree.pane_id === paneId ? { kind: 'pane', pane_id: '' } : tree
  }
  const first = removeLeaf(tree.first, paneId)
  const second = removeLeaf(tree.second, paneId)
  if (first.kind === 'pane' && !first.pane_id) {
    return second
  }
  if (second.kind === 'pane' && !second.pane_id) {
    return first
  }
  return { ...tree, first, second }
}

export function firstPaneId(tree: LayoutTree): string | null {
  if (tree.kind === 'pane') {
    return tree.pane_id || null
  }
  return firstPaneId(tree.first) ?? firstPaneId(tree.second)
}

export function leafInTree(tree: LayoutTree, paneId: string): boolean {
  if (tree.kind === 'pane') {
    return tree.pane_id === paneId
  }
  return leafInTree(tree.first, paneId) || leafInTree(tree.second, paneId)
}

export function setRatioOnSplitContaining(
  tree: LayoutTree,
  paneId: string,
  ratio: number
): boolean {
  if (tree.kind === 'pane') {
    return false
  }
  if (leafInTree(tree.first, paneId) || leafInTree(tree.second, paneId)) {
    tree.ratio = ratio
    return true
  }
  return (
    setRatioOnSplitContaining(tree.first, paneId, ratio) ||
    setRatioOnSplitContaining(tree.second, paneId, ratio)
  )
}

export function layoutRects(
  tree: LayoutTree,
  area: HerdrPaneLayoutRect,
  panes: Map<string, ModelPane>
): { pane_id: string; rect: HerdrPaneLayoutRect; focused?: boolean }[] {
  const result: { pane_id: string; rect: HerdrPaneLayoutRect; focused?: boolean }[] = []
  collectRects(tree, area, result, panes)
  return result
}

function collectRects(
  tree: LayoutTree,
  area: HerdrPaneLayoutRect,
  out: { pane_id: string; rect: HerdrPaneLayoutRect }[],
  _panes: Map<string, ModelPane>
): void {
  if (tree.kind === 'pane') {
    out.push({ pane_id: tree.pane_id, rect: area })
    return
  }
  if (tree.direction === 'right') {
    const firstWidth = Math.round(area.width * tree.ratio)
    collectRects(tree.first, { ...area, width: firstWidth }, out, _panes)
    collectRects(
      tree.second,
      { ...area, x: area.x + firstWidth, width: area.width - firstWidth },
      out,
      _panes
    )
  } else {
    const firstHeight = Math.round(area.height * tree.ratio)
    collectRects(tree.first, { ...area, height: firstHeight }, out, _panes)
    collectRects(
      tree.second,
      { ...area, y: area.y + firstHeight, height: area.height - firstHeight },
      out,
      _panes
    )
  }
}

export function splitRects(
  tree: LayoutTree,
  area: HerdrPaneLayoutRect
): {
  id: string
  direction: 'right' | 'down'
  ratio: number
  rect: HerdrPaneLayoutRect
}[] {
  if (tree.kind === 'pane') {
    return []
  }
  const split: {
    id: string
    direction: 'right' | 'down'
    ratio: number
    rect: HerdrPaneLayoutRect
  } = {
    id: `split-${area.x}-${area.y}`,
    direction: tree.direction,
    ratio: tree.ratio,
    rect: area
  }
  const firstArea =
    tree.direction === 'right'
      ? { ...area, width: Math.round(area.width * tree.ratio) }
      : { ...area, height: Math.round(area.height * tree.ratio) }
  const secondArea =
    tree.direction === 'right'
      ? { ...area, x: area.x + firstArea.width, width: area.width - firstArea.width }
      : { ...area, y: area.y + firstArea.height, height: area.height - firstArea.height }
  return [split, ...splitRects(tree.first, firstArea), ...splitRects(tree.second, secondArea)]
}

export function layoutNodeFromTree(tree: LayoutTree, panes: Map<string, ModelPane>): LayoutNode {
  if (tree.kind === 'pane') {
    const pane = panes.get(tree.pane_id)
    return {
      type: 'pane',
      pane_id: tree.pane_id,
      label: pane?.label ?? null,
      cwd: pane?.cwd ?? null
    }
  }
  return {
    type: 'split',
    direction: tree.direction,
    ratio: tree.ratio,
    first: layoutNodeFromTree(tree.first, panes),
    second: layoutNodeFromTree(tree.second, panes)
  }
}

function collectLeaves(node: LayoutNode, out: LayoutNode[]): void {
  if (node.type === 'pane') {
    out.push(node)
    return
  }
  requireSplitChildren(node)
  collectLeaves(node.first as LayoutNode, out)
  collectLeaves(node.second as LayoutNode, out)
}

function requireSplitChildren(node: LayoutNode): void {
  if (!node.first || !node.second) {
    throw new HerdrRuntimeError(
      'invalid_layout',
      `Split layout node is missing a child (direction=${node.direction ?? 'right'})`
    )
  }
}

function assembleLayout(node: LayoutNode, ids: string[]): LayoutTree {
  let index = 0
  const assemble = (current: LayoutNode): LayoutTree => {
    if (current.type === 'pane') {
      return { kind: 'pane', pane_id: ids[index++] }
    }
    requireSplitChildren(current)
    return {
      kind: 'split',
      direction: current.direction ?? 'right',
      ratio: current.ratio ?? DEFAULT_RATIO,
      first: assemble(current.first as LayoutNode),
      second: assemble(current.second as LayoutNode)
    }
  }
  return assemble(node)
}

// Why: structural layout.apply clears the tab's panes, spawns ids in DFS leaf
// order, then assembles the tree. Mutates the model's maps via the deps closure.
export function applyLayoutToTab(params: {
  panes: Map<string, ModelPane>
  tab: ModelTab
  workspaceId: string
  root: LayoutNode
  defaultCwd: string
  nextPaneId: () => string
}): string[] {
  const { panes, tab, workspaceId, root, defaultCwd, nextPaneId } = params
  for (const pane of panes.values()) {
    if (pane.tab_id === tab.tab_id) {
      panes.delete(pane.pane_id)
    }
  }
  tab.root = { kind: 'pane', pane_id: '' }
  const leaves: LayoutNode[] = []
  collectLeaves(root, leaves)
  const created = leaves.map((leaf) => {
    const paneId = nextPaneId()
    panes.set(paneId, {
      pane_id: paneId,
      tab_id: tab.tab_id,
      workspace_id: workspaceId,
      cwd: leaf.cwd ?? defaultCwd,
      label: leaf.label ?? undefined,
      revision: 0,
      agent: null,
      agent_status: 'idle'
    })
    return paneId
  })
  tab.root = assembleLayout(root, created)
  tab.focused_pane_id = firstPaneId(tab.root)
  return created
}
