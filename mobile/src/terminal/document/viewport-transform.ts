import { paintBottomRowBackdrop } from './bottom-row-backdrop'
import { repositionOverlay } from './selection-overlay'
import { shouldRouteScrollToTerminalInput } from './mouse-input-encoding'
import type { TerminalDocumentScope } from './document-scope'
import { getCellWidth, getTotalScale } from './cell-metrics'

// First live output can widen a buffer measured during replay; permit one fresh fit before preserving user zoom.

export function flog(scope: TerminalDocumentScope, tag: string, payload: Record<string, unknown>) {
  try {
    scope.postToHost({
      type: 'log',
      tag: '[fit]' + tag,
      payload: payload
    })
  } catch {}
}

// Prefer renderer cell width × columns; use content-dependent scrollWidth only before renderer metrics exist.
export function computeFitScale(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return 1
  }
  const cellW = getCellWidth(scope)
  const termWidth =
    cellW > 0 ? cellW * scope.term.cols : scope.term.element ? scope.term.element.scrollWidth : 0
  if (termWidth <= 0) {
    return 1
  }
  const vpWidth = scope.viewportRect().width
  // A not-yet-laid-out host has zero width; zero scale would blank its grid.
  if (vpWidth <= 0) {
    return 1
  }
  return Math.min(1, vpWidth / termWidth)
}

export function updateTransform(scope: TerminalDocumentScope) {
  scope.surface!.style.transform =
    'translate(' + scope.panX + 'px,' + scope.panY + 'px) scale(' + getTotalScale(scope) + ')'
  updateScrollIndicator(scope, false)
  paintBottomRowBackdrop(scope)
  if (scope.selMode === 'select') {
    repositionOverlay(scope)
  }
}

export function updateScrollIndicator(scope: TerminalDocumentScope, reveal: boolean) {
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
  if (maxViewportY <= 0 || shouldRouteScrollToTerminalInput(scope)) {
    scope.scrollIndicator.classList.remove('visible')
    return
  }
  const trackHeight = Math.max(0, scope.viewportRect().height - 8)
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

export function stopViewportTransform(scope: TerminalDocumentScope) {
  if (scope.scrollIndicatorHideTimer) {
    clearTimeout(scope.scrollIndicatorHideTimer)
    scope.scrollIndicatorHideTimer = null
  }
}
