import { cellToViewportPx } from './cell-geometry'
import { scope } from './document-scope'
import { getCellHeight } from './fit-scale'
import { notify } from './host-notify'
import { applyXtermSelection, selRange } from './selection-range'
import { viewportToCell } from './viewport-cell'
import { getTotalScale } from './viewport-transform'

export function repositionOverlay() {
  if (scope.selMode !== 'select' || !scope.sel || !scope.term) {
    return
  }
  const r = selRange()!
  const sPx = cellToViewportPx(r.start.col, r.start.row)
  const ePx = cellToViewportPx(r.end.col + 1, r.end.row)
  const cellH = getCellHeight() * getTotalScale()
  // Why: native iOS pattern — start handle anchors at the TOP of the
  // first selected cell (dot above, stem covers the cell going down);
  // end handle anchors at the BOTTOM of the last selected cell (dot
  // below, stem covers the cell going up).
  scope.handleStart!.style.left = sPx.x + 'px'
  scope.handleStart!.style.top = sPx.y + 'px'
  scope.handleEnd!.style.left = ePx.x + 'px'
  scope.handleEnd!.style.top = ePx.y + cellH + 'px'
  const startVisible = sPx.y >= 0 && sPx.y <= window.innerHeight
  const endVisible = ePx.y >= 0 && ePx.y <= window.innerHeight
  scope.handleStart!.style.visibility = startVisible ? 'visible' : 'hidden'
  scope.handleEnd!.style.visibility = endVisible ? 'visible' : 'hidden'
  let menuCenterX: number, menuY: number, vTransform: string, marginTop: string
  if (startVisible && sPx.y > 56) {
    menuCenterX = sPx.x
    menuY = sPx.y
    vTransform = 'translateY(-100%)'
    marginTop = '-12px'
  } else if (endVisible && ePx.y + cellH + 56 < window.innerHeight) {
    menuCenterX = ePx.x
    menuY = ePx.y + cellH
    vTransform = 'translateY(0)'
    marginTop = '12px'
  } else {
    // selection covers full viewport — pin to visible center
    menuCenterX = window.innerWidth / 2
    menuY = window.innerHeight / 2
    vTransform = 'translateY(-50%)'
    marginTop = '0'
  }
  // Why: clamp horizontally so the pill stays fully visible when the
  // selection sits near a screen edge. We position via plain left
  // (no horizontal translate) so the clamp math is straightforward.
  scope.selMenu!.style.transform = vTransform
  scope.selMenu!.style.marginTop = marginTop
  scope.selMenu!.style.top = menuY + 'px'
  scope.selMenu!.style.left = '0px'
  const EDGE_MARGIN = 8
  const menuW = scope.selMenu!.offsetWidth || 0
  const minLeft = EDGE_MARGIN
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - menuW - EDGE_MARGIN)
  const desiredLeft = menuCenterX - menuW / 2
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, desiredLeft))
  scope.selMenu!.style.left = clampedLeft + 'px'
}

export function syncSelectionHandleToViewportPoint(
  handle: string,
  clientX: number,
  clientY: number
) {
  const c = viewportToCell(clientX, clientY)
  if (!c || !scope.sel) {
    return false
  }
  if (handle === 'start') {
    scope.sel.anchor = c
  } else {
    scope.sel.focus = c
  }
  applyXtermSelection()
  return true
}

export function syncEdgeScrollSelectionEndpoint() {
  if (!scope.sel || !scope.sel.activeHandle) {
    return false
  }
  // Why: WebView may not emit new touchmove events while a handle is held
  // at the edge; resample the stored finger point after each viewport scroll.
  return syncSelectionHandleToViewportPoint(
    scope.sel.activeHandle,
    scope.edgeScrollClientX,
    scope.edgeScrollClientY
  )
}

export function startEdgeScroll(dir: number) {
  if (scope.edgeScrollDir === dir) {
    return
  }
  stopEdgeScroll()
  scope.edgeScrollDir = dir
  scope.edgeScrollTimer = setInterval(function () {
    if (!scope.term || scope.edgeScrollDir === 0) {
      return
    }
    const beforeY = scope.term.buffer.active.viewportY
    scope.term.scrollLines(scope.edgeScrollDir)
    const afterY = scope.term.buffer.active.viewportY
    if (beforeY === afterY) {
      notify({ type: 'haptic', kind: 'edge-bump' })
      stopEdgeScroll()
      return
    }
    syncEdgeScrollSelectionEndpoint()
    repositionOverlay()
  }, scope.EDGE_SCROLL_INTERVAL)
}

export function stopEdgeScroll() {
  if (scope.edgeScrollTimer) {
    clearInterval(scope.edgeScrollTimer)
    scope.edgeScrollTimer = null
  }
  scope.edgeScrollDir = 0
}

export function handleDragMove(handle: string, clientX: number, clientY: number) {
  scope.edgeScrollClientX = clientX
  scope.edgeScrollClientY = clientY
  if (!syncSelectionHandleToViewportPoint(handle, clientX, clientY)) {
    return
  }
  repositionOverlay()
  if (clientY < scope.EDGE_SCROLL_PX) {
    startEdgeScroll(-1)
  } else if (clientY > window.innerHeight - scope.EDGE_SCROLL_PX) {
    startEdgeScroll(1)
  } else {
    stopEdgeScroll()
  }
}

// Latching document-level touch dispatcher: see tap-dispatch.ts.

/** Ruling 21: the edge-scroll interval, which outlives the selection that started it. */
export function stopSelectionOverlay() {
  stopEdgeScroll()
}
