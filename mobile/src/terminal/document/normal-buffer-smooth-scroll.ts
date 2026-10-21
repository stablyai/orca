import { getCellHeight, getTotalScale } from './cell-metrics'
import { repositionOverlay } from './selection-overlay'
import { updateScrollIndicator } from './viewport-transform'
import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'

export function clampNormalScrollLines(scope: TerminalDocumentScope, lines: number) {
  if (!scope.term || !scope.term.buffer || !scope.term.buffer.active || lines === 0) {
    return 0
  }
  const buffer = scope.term.buffer.active
  if (lines > 0) {
    return Math.min(lines, Math.max(0, buffer.baseY - buffer.viewportY))
  }
  return Math.max(lines, -buffer.viewportY)
}

export function canScrollNormalBufferDelta(scope: TerminalDocumentScope, deltaY: number) {
  if (!scope.term || !scope.term.buffer || !scope.term.buffer.active || deltaY === 0) {
    return false
  }
  const buffer = scope.term.buffer.active
  if (deltaY > 0) {
    return buffer.viewportY < buffer.baseY
  }
  // Why: at the top row, a grid still shifted up by a fraction has that fraction left to travel.
  return buffer.viewportY > 0 || (scope.pixelScrollActive && scope.smoothScrollOffsetY < 0)
}

export function applyNormalBufferScrollDelta(scope: TerminalDocumentScope, deltaY: number) {
  if (!scope.term || deltaY === 0) {
    return false
  }
  const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
  if (effectiveCellH <= 0) {
    return false
  }
  // Why: the renderer answers whether it can draw a sub-row offset (one not created yet cannot).
  // A change either way restarts from whole rows, so no fraction is kept that nothing draws.
  const pixelScroll =
    scope.term.setViewportPixelOffset?.(scope.smoothScrollOffsetY / getTotalScale(scope)) === true
  if (pixelScroll !== scope.pixelScrollActive) {
    scope.pixelScrollActive = pixelScroll
    scope.smoothScrollOffsetY = 0
    scope.term.setViewportPixelOffset?.(0)
  }
  if (!canScrollNormalBufferDelta(scope, deltaY)) {
    resetSmoothScrollOffset(scope)
    return false
  }
  scope.smoothScrollOffsetY -= deltaY
  if (pixelScroll) {
    // Why: text that moved makes this touch a scroll, not a tap.
    scope.tapCandidate = null
  }
  // Why: the renderer only shifts the grid up, over the rows it draws below the last one, so
  // xterm's viewport takes the older whole row and the remainder is always a shift up.
  const lines = pixelScroll
    ? Math.floor(-scope.smoothScrollOffsetY / effectiveCellH)
    : Math.trunc(-scope.smoothScrollOffsetY / effectiveCellH)
  if (lines !== 0) {
    const applied = clampNormalScrollLines(scope, lines)
    if (applied !== 0) {
      scope.term.scrollLines(applied)
      // Why: xterm's parser and viewport are row-based. Buffer touch pixels and only commit whole
      // rows; a renderer that can draws the remainder as a pixel shift, and one that cannot keeps
      // TUI canvas layers from shimmering between fractional transforms and xterm repaints.
      scope.smoothScrollOffsetY += applied * effectiveCellH
    }
    if (applied !== lines) {
      scope.smoothScrollOffsetY = 0
    }
  }
  const limit = effectiveCellH - 1
  if (scope.smoothScrollOffsetY > limit) {
    scope.smoothScrollOffsetY = limit
  }
  if (scope.smoothScrollOffsetY < -limit) {
    scope.smoothScrollOffsetY = -limit
  }
  updateScrollIndicator(scope, true)
  if (pixelScroll) {
    // Why: the live bottom has no row below it to show, so it rests on whole rows.
    if (scope.term.buffer.active.viewportY >= scope.term.buffer.active.baseY) {
      scope.smoothScrollOffsetY = 0
    }
    scope.term.setViewportPixelOffset?.(scope.smoothScrollOffsetY / getTotalScale(scope))
    if (scope.selMode === 'select') {
      repositionOverlay(scope)
    }
  }
  return true
}

export function enqueueNormalBufferScrollDelta(scope: TerminalDocumentScope, deltaY: number) {
  if (!scope.term || deltaY === 0) {
    return false
  }
  if (!canScrollNormalBufferDelta(scope, deltaY)) {
    resetSmoothScrollOffset(scope)
    return false
  }
  scope.pendingNormalScrollDeltaY += deltaY
  if (scope.normalScrollFrameId !== null) {
    return true
  }
  // Why: dense terminal rows are expensive to repaint. Coalesce touchmove
  // deltas into one xterm row-scroll per frame instead of repainting from
  // the input event stream.
  scope.normalScrollFrameId = scheduleDocumentFrame(scope, function () {
    scope.normalScrollFrameId = null
    const delta = scope.pendingNormalScrollDeltaY
    scope.pendingNormalScrollDeltaY = 0
    if (!applyNormalBufferScrollDelta(scope, delta)) {
      resetSmoothScrollOffset(scope)
    }
  })
  return true
}

/** Drops the travel waiting for the next frame and keeps the offset already drawn. */
export function cancelPendingNormalScroll(scope: TerminalDocumentScope) {
  scope.pendingNormalScrollDeltaY = 0
  if (scope.normalScrollFrameId !== null) {
    cancelAnimationFrame(scope.normalScrollFrameId)
    scope.normalScrollFrameId = null
  }
}

export function resetSmoothScrollOffset(scope: TerminalDocumentScope) {
  cancelPendingNormalScroll(scope)
  scope.term?.setViewportPixelOffset?.(0)
  if (scope.smoothScrollOffsetY === 0) {
    return
  }
  scope.smoothScrollOffsetY = 0
  updateScrollIndicator(scope, false)
}

/** Ruling 21: the smooth-scroll frame, which would otherwise scroll the next mount's buffer. */
export function stopNormalBufferSmoothScroll(scope: TerminalDocumentScope) {
  resetSmoothScrollOffset(scope)
}
