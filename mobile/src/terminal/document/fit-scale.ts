import { repositionOverlay } from './selection-overlay'
import {
  computeFitScale,
  flog,
  getCellWidth,
  getTotalScale,
  updateTransform
} from './viewport-transform'
import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'

/** The narrowest grid a fit or a text-scale change will fit to. */
export const MIN_FIT_COLS = 20

export function getCellHeight(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.term._core) {
    return 15
  }
  const core = scope.term._core
  if (core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.height || 15
  }
  return 15
}

// Why: clamp pan so the terminal content always covers the viewport
// when zoomed in. When content is smaller than viewport in a
// dimension, pin to top-left (no floating in the middle).
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

// Why: intentional no-op. Mobile replays a live PTY snapshot then applies
// live cursor-relative chunks from that same PTY; resizing only the WebView
// xterm changes cursor coordinates and makes TUI repaint chunks duplicate or
// overlap. Kept as a no-op so its call sites stay legible.
export function adjustRowsForViewport() {}

// Why: cold-start fit. After init() opens xterm, the renderer needs
// several frames before cell dimensions are computed. Reading too early
// gives cellWidth=0 (renderer service not ready) or scrollWidth=0 (DOM
// not laid out), and computeFitScale returns 1 → no zoom.
//
// Gate: cellWidth × cols is the canonical "logical width" of the grid
// and reflects xterm's layout decision, independent of buffer content.
// We commit when cellWidth becomes positive (renderer ready). Fallback:
// if cellWidth never becomes available, gate on stable positive
// scrollWidth (xterm rendered something). Cap at 60 frames (~1s @60Hz)
// so a backgrounded WebView never spins forever.
const FIT_RETRY_MAX_FRAMES = 60

function isFittedBox(scope: TerminalDocumentScope) {
  const { width, height } = scope.viewportRect()
  const fitted = scope.fittedBox
  return fitted !== null && fitted.width === width && fitted.height === height
}

function hasViewportWidth(scope: TerminalDocumentScope) {
  const width = scope.viewportRect().width
  return Number.isFinite(width) && width > 0
}

export function applyFitScale(scope: TerminalDocumentScope, reason: string) {
  if (!scope.term || !scope.term.element) {
    return
  }
  // Why: a fit asked for while hidden is dropped until a box arrives, and that box may be the old one.
  scope.fittedBox = null
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
    // Why: a display:none host measures 0 wide; the fit stays pending until observeViewport reports a box.
    if (!hasViewportWidth(scope)) {
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
  const { width, height } = scope.viewportRect()
  scope.fittedBox = { width, height }
  scope.currentScale = preSnapScale
  // Why: when scale is very close to 1 (e.g. 0.97 from xterm scrollbar
  // sub-pixels) snap to 1 to avoid imperceptible shrinkage that prevents
  // a second applyFitScale from observing a "no-op needed" state.
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
  const suspect = scope.currentScale === 1 && scope.term.cols > 0 && expectedW > vpW + 1 // expected wider than viewport but no zoom
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
}

/**
 * The refit every host needs: the viewport changed, so the scale the fit was computed against is
 * gone. A keyboard opening or closing, an orientation change, a shell resizing the container.
 *
 * Owned here because the refit is this module's own work — it was reached through the WebView's
 * message bridge only because that was where the listener happened to be installed, and the page
 * had to copy the five calls into its mount to get it at all (ruling 24).
 */
export function startFitScale(scope: TerminalDocumentScope) {
  const refit = () => {
    // Why: a hidden screen reports 0x0 and then its old box again; native never refits on that, so
    // only a box other than the one last fitted refits, and the user's pan and zoom survive.
    if (!hasViewportWidth(scope) || isFittedBox(scope)) {
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

/**
 * Ruling 21: the retry loop is abandoned by bumping the token it compares itself against, which is
 * how it already abandons a superseded attempt.
 */
export function stopFitScale(scope: TerminalDocumentScope) {
  scope.fitRetryToken++
  if (scope.removeViewportRefit) {
    scope.removeViewportRefit()
    scope.removeViewportRefit = null
  }
}
