import { getCellHeight, getTotalScale } from './cell-metrics'
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
  return buffer.viewportY > 0
}

export function applyNormalBufferScrollDelta(scope: TerminalDocumentScope, deltaY: number) {
  if (!scope.term || deltaY === 0) {
    return false
  }
  const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
  if (effectiveCellH <= 0) {
    return false
  }
  if (!canScrollNormalBufferDelta(scope, deltaY)) {
    resetSmoothScrollOffset(scope)
    return false
  }
  scope.smoothScrollOffsetY -= deltaY
  const lines = Math.trunc(-scope.smoothScrollOffsetY / effectiveCellH)
  if (lines !== 0) {
    const applied = clampNormalScrollLines(scope, lines)
    if (applied !== 0) {
      scope.term.scrollLines(applied)
      // Moving a whole row counts as scroll even within tap slop.
      scope.tapCandidate = null
      // Commit whole rows so fractional transforms cannot shimmer against xterm’s row-based repaint.
      scope.smoothScrollOffsetY += applied * effectiveCellH
    }
    if (applied !== lines) {
      scope.smoothScrollOffsetY = 0
    }
  }
  updateScrollIndicator(scope, true)
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
  // Coalesce touchmove deltas to one row scroll per frame to bound dense-terminal repaints.
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

export function queuedNormalBufferScrollReachesRow(scope: TerminalDocumentScope) {
  const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
  return (
    effectiveCellH > 0 &&
    Math.abs(scope.smoothScrollOffsetY - scope.pendingNormalScrollDeltaY) >= effectiveCellH
  )
}

export function resetSmoothScrollOffset(scope: TerminalDocumentScope) {
  scope.pendingNormalScrollDeltaY = 0
  if (scope.normalScrollFrameId !== null) {
    cancelAnimationFrame(scope.normalScrollFrameId)
    scope.normalScrollFrameId = null
  }
  if (scope.smoothScrollOffsetY === 0) {
    return
  }
  scope.smoothScrollOffsetY = 0
  updateScrollIndicator(scope, false)
}

export function stopNormalBufferSmoothScroll(scope: TerminalDocumentScope) {
  resetSmoothScrollOffset(scope)
}
