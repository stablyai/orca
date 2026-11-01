import { repositionOverlay } from './selection-overlay'
import { computeFitScale, flog, updateTransform } from './viewport-transform'
import { getCellWidth, getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import type { TerminalViewportChange } from './document-host-seams'
import { scheduleDocumentFrame } from './document-frame-registry'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'

// Keep content covering the viewport; smaller dimensions pin top-left rather than floating.
export function clampPan(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.term.element) {
    return
  }
  const ts = getTotalScale(scope)
  const cw = scope.term.element.scrollWidth * ts
  const ch = scope.term.element.scrollHeight * ts
  const { width: vpW, height: vpH } = scope.viewportRect()
  if (cw > vpW) {
    scope.panX = Math.min(0, Math.max(vpW - cw, scope.panX))
  } else {
    scope.panX = 0
  }
  if (ch > vpH) {
    scope.panY = Math.min(0, Math.max(vpH - ch, scope.panY))
  } else {
    scope.panY = 0
  }
}

// Intentional no-op: resizing only phone xterm would change cursor coordinates and corrupt subsequent live PTY repaints.
export function adjustRowsForViewport() {}

// Cold xterm layout needs frames before cells are measured; prefer cell width, fall back to stable scrollWidth, and bound retries.
const FIT_RETRY_MAX_FRAMES = 60

function isViewportShown(scope: TerminalDocumentScope) {
  const { width, hidden } = scope.viewportRect()
  return hidden !== true && Number.isFinite(width) && width > 0
}

export function applyFitScale(scope: TerminalDocumentScope, reason: string) {
  if (!scope.term || !scope.term.element) {
    return
  }
  const token = ++scope.fitRetryToken
  let attempts = 0
  let lastScrollWidth = -1
  function attempt() {
    if (token !== scope.fitRetryToken) {
      return
    }
    if (!scope.term || !scope.term.element) {
      return
    }
    // Hidden grids may not measure cells; defer fit until shown.
    if (!isViewportShown(scope)) {
      scope.fitPending = reason
      return
    }
    attempts++
    const cellW = getCellWidth(scope)
    if (cellW > 0 && scope.term.cols > 0) {
      commitFitScale(scope, reason, attempts, 'cellW')
      return
    }
    const w = scope.term.element.scrollWidth
    if (w > 0 && w === lastScrollWidth) {
      commitFitScale(scope, reason, attempts, 'stableSW')
      return
    }
    lastScrollWidth = w
    if (attempts >= FIT_RETRY_MAX_FRAMES) {
      flog(scope, 'commit-timeout', {
        reason: reason,
        attempts: attempts,
        cellW: cellW,
        scrollWidth: w,
        cols: scope.term.cols
      })
      commitFitScale(scope, reason, attempts, 'timeout')
      return
    }
    scheduleDocumentFrame(scope, attempt)
  }
  scheduleDocumentFrame(scope, attempt)
}

export function commitFitScale(
  scope: TerminalDocumentScope,
  reason: string,
  attempts: number,
  gate: string
) {
  if (!scope.term || !scope.term.element) {
    return
  }
  const preSnapScale = computeFitScale(scope)
  scope.fitPending = null
  scope.currentScale = preSnapScale
  // Snap near-one fits to one so sub-pixel scrollbars cannot create endless non-noop fits.
  if (scope.currentScale >= 0.95) {
    scope.currentScale = 1
  }
  scope.userScale = 1
  scope.panX = 0
  scope.panY = 0
  scope.smoothScrollOffsetY = 0
  updateTransform(scope)
  adjustRowsForViewport()

  const cellW = getCellWidth(scope)
  const sw = scope.term.element.scrollWidth
  const vpW = scope.viewportRect().width
  const expectedW = cellW * scope.term.cols
  const suspect = scope.currentScale === 1 && scope.term.cols > 0 && expectedW > vpW + 1
  if (suspect) {
    flog(scope, 'commit-SUSPECT', {
      reason: reason,
      attempts: attempts,
      gate: gate,
      preSnapScale: preSnapScale,
      finalScale: scope.currentScale,
      cellW: cellW,
      cols: scope.term.cols,
      expectedW: expectedW,
      scrollWidth: sw,
      vpWidth: vpW
    })
  }
  repositionOverlay(scope)
  // Scale changes drawn row pitch even without new terminal output.
  emitKeyboardAvoidanceMetrics(scope)
}

// Viewport resize invalidates fit for every host, including keyboard and orientation changes.
export function startFitScale(scope: TerminalDocumentScope) {
  const refit = (change: TerminalViewportChange) => {
    // Reshowing the same box preserves pan/zoom unless a hidden fit was deferred.
    if (change === 'shown') {
      if (scope.fitPending !== null) {
        applyFitScale(scope, scope.fitPending)
      }
      return
    }
    applyFitScale(scope, 'window-resize')
    adjustRowsForViewport()
    repositionOverlay(scope)
    clampPan(scope)
    updateTransform(scope)
  }
  scope.removeViewportRefit = scope.observeViewport(refit)
}

export function stopFitScale(scope: TerminalDocumentScope) {
  scope.fitRetryToken++
  if (scope.removeViewportRefit) {
    scope.removeViewportRefit()
    scope.removeViewportRefit = null
  }
}
