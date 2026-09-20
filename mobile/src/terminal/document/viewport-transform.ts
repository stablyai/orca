import { repositionOverlay } from './selection-overlay'
import { shouldRouteScrollToTerminalInput } from './mouse-input-encoding'
import { scope } from './document-scope'

// Why: after init() the initial scrollback applyFitScale may have run
// against an empty buffer (or one without the widest line yet). Re-fit
// once when the first live data chunk arrives so a wider line that pushes
// scrollWidth past the previously-measured value gets re-scaled to fit.

// Diagnostic logger — bridges WebView console.log to RN via postMessage.
// Tag with [fit] so it's easy to filter in the Expo/Metro logs.
export function flog(tag: string, payload: Record<string, unknown>) {
  try {
    scope.postToHost({
      type: 'log',
      tag: '[fit]' + tag,
      payload: payload
    })
  } catch {}
}

export function getCellWidth() {
  if (!scope.term || !scope.term._core) {
    return 0
  }
  const core = scope.term._core
  if (core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.width || 0
  }
  return 0
}

// Why: width measurement strategy.
//   1. Prefer cellWidth × term.cols — this is what xterm's renderer uses
//      to lay out and is independent of buffer content. It's the "logical
//      width" of the terminal grid.
//   2. Fall back to term.element.scrollWidth — the actual rendered DOM
//      width — only when cellWidth isn't available yet (renderer not
//      initialized). This is content-dependent (reflects widest row),
//      but better than nothing.
//   3. If both are 0, return 1 (no scale change). The retry loop in
//      applyFitScale will keep trying until one is positive.
export function computeFitScale() {
  if (!scope.term) {
    return 1
  }
  const cellW = getCellWidth()
  const termWidth =
    cellW > 0 ? cellW * scope.term.cols : scope.term.element ? scope.term.element.scrollWidth : 0
  if (termWidth <= 0) {
    return 1
  }
  const vpWidth = window.innerWidth
  return Math.min(1, vpWidth / termWidth)
}

export function getTotalScale() {
  return scope.currentScale * scope.userScale
}

export function updateTransform() {
  scope.surface!.style.transform =
    'translate(' + scope.panX + 'px,' + scope.panY + 'px) scale(' + getTotalScale() + ')'
  updateScrollIndicator(false)
  if (scope.selMode === 'select') {
    repositionOverlay()
  }
}

export function updateScrollIndicator(reveal: boolean) {
  if (
    !scope.scrollIndicator ||
    !scope.scrollThumb ||
    !scope.term ||
    !scope.term.buffer ||
    !scope.term.buffer.active
  ) {
    return
  }
  const buffer = scope.term.buffer.active
  const maxViewportY = buffer.baseY || 0
  if (maxViewportY <= 0 || shouldRouteScrollToTerminalInput()) {
    scope.scrollIndicator.classList.remove('visible')
    return
  }
  const trackHeight = Math.max(0, window.innerHeight - 8)
  const totalRows = maxViewportY + (scope.term.rows || 0)
  if (trackHeight <= 0 || totalRows <= 0) {
    return
  }
  const thumbHeight = Math.max(24, (trackHeight * (scope.term.rows || 0)) / totalRows)
  const maxTop = Math.max(0, trackHeight - thumbHeight)
  const top = maxViewportY > 0 ? (buffer.viewportY / maxViewportY) * maxTop : 0
  scope.scrollThumb.style.height = thumbHeight + 'px'
  scope.scrollThumb.style.transform = 'translateY(' + top + 'px)'
  if (!reveal) {
    return
  }
  scope.scrollIndicator.classList.add('visible')
  if (scope.scrollIndicatorHideTimer) {
    clearTimeout(scope.scrollIndicatorHideTimer)
  }
  scope.scrollIndicatorHideTimer = setTimeout(function () {
    scope.scrollIndicator!.classList.remove('visible')
    scope.scrollIndicatorHideTimer = null
  }, 550)
}

/** Ruling 21: the hide timer is the one thing this module schedules. */
export function stopViewportTransform() {
  if (scope.scrollIndicatorHideTimer) {
    clearTimeout(scope.scrollIndicatorHideTimer)
    scope.scrollIndicatorHideTimer = null
  }
}
