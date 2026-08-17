import type { HerdrPaneLayoutRect } from './herdr-socket-types'
import type { LayoutTree } from './herdr-daemon-model-types'
import { layoutRects } from './herdr-daemon-layout'

// Why: rect-geometry helpers for pane.neighbor/edges/swap live apart from the
// tree mutation helpers so neither module exceeds the line budget.

export function swapLeaves(tree: LayoutTree, paneIdA: string, paneIdB: string): LayoutTree {
  if (tree.kind === 'pane') {
    if (tree.pane_id === paneIdA) {
      return { ...tree, pane_id: paneIdB }
    }
    if (tree.pane_id === paneIdB) {
      return { ...tree, pane_id: paneIdA }
    }
    return tree
  }
  return {
    ...tree,
    first: swapLeaves(tree.first, paneIdA, paneIdB),
    second: swapLeaves(tree.second, paneIdA, paneIdB)
  }
}

function directionalGap(
  a: HerdrPaneLayoutRect,
  b: HerdrPaneLayoutRect,
  direction: 'left' | 'right' | 'up' | 'down'
): number | null {
  if (direction === 'right') {
    if (b.x + b.width <= a.x + a.width) {
      return null
    }
    const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return overlap > 0 ? b.x - (a.x + a.width) : null
  }
  if (direction === 'left') {
    if (b.x >= a.x) {
      return null
    }
    const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return overlap > 0 ? a.x - (b.x + b.width) : null
  }
  if (direction === 'down') {
    if (b.y + b.height <= a.y + a.height) {
      return null
    }
    const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    return overlap > 0 ? b.y - (a.y + a.height) : null
  }
  if (b.y >= a.y) {
    return null
  }
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  return overlap > 0 ? a.y - (b.y + b.height) : null
}

export function paneNeighbor(
  tree: LayoutTree,
  paneId: string,
  direction: 'left' | 'right' | 'up' | 'down',
  area: HerdrPaneLayoutRect
): string | null {
  const rects = layoutRects(tree, area, new Map())
  const source = rects.find((entry) => entry.pane_id === paneId)
  if (!source) {
    return null
  }
  let best: { pane_id: string; distance: number } | null = null
  for (const candidate of rects) {
    if (candidate.pane_id === paneId) {
      continue
    }
    const gap = directionalGap(source.rect, candidate.rect, direction)
    if (gap === null) {
      continue
    }
    if (best === null || gap < best.distance) {
      best = { pane_id: candidate.pane_id, distance: gap }
    }
  }
  return best?.pane_id ?? null
}

export function paneEdges(
  tree: LayoutTree,
  paneId: string,
  area: HerdrPaneLayoutRect
): { left: boolean; right: boolean; up: boolean; down: boolean } {
  const rects = layoutRects(tree, area, new Map())
  const source = rects.find((entry) => entry.pane_id === paneId)
  if (!source) {
    return { left: false, right: false, up: false, down: false }
  }
  return {
    left: source.rect.x === area.x,
    right: source.rect.x + source.rect.width >= area.x + area.width,
    up: source.rect.y === area.y,
    down: source.rect.y + source.rect.height >= area.y + area.height
  }
}
