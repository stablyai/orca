import { elementInRoot } from './document-host-seams'
import { repositionOverlay } from './selection-overlay'
import { cancelSelect } from './selection-range'
import { notify } from './host-notify'
import type { TerminalDocumentScope } from './document-scope'

// ============================================================
// SELECTION MODE (long-press → handles → Copy)
// ============================================================

// Why: a tap that opens a link/path must survive small finger jitter. The
// long-press slop (10px) only cancels the press-to-select timer; reusing it
// to gate the tap dropped any URL/file tap that wandered >10px — at fit scale
// a few screen px of jitter is a normal tap. Use a wider, time-bounded tap
// window so deliberate scrolls/pans still don't fire a tap.

// mode: 'navigate' | 'select'

// { anchor:{col,row}, focus:{col,row}, activeHandle:null|'start'|'end' }

// {x,y, identifier}
// Why: tap detection is tracked separately from the long-press timer so a
// small jitter that cancels the press-to-select timer does not also cancel
// the tap (which opens links/paths). {x,y,t,identifier} or null once the
// gesture is disqualified as a tap (moved too far or held too long).

// Eviction watchdog: linesEverWritten counts onLineFeed since the last init.
// Once buffer is full, every onLineFeed evicts the top row in xterm and
// we mirror that by decrementing stored absolute rows.

export function resetEvictionCounter(scope: TerminalDocumentScope) {
  scope.linesEverWritten = 0
}

export function isBufferFull(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return false
  }
  return scope.linesEverWritten >= 5000 + (scope.term.rows || 0)
}

export function checkEviction(scope: TerminalDocumentScope) {
  if (scope.selMode !== 'select' || !scope.sel) {
    return
  }
  const oldest = Math.min(scope.sel.anchor.row, scope.sel.focus.row)
  if (oldest < 0) {
    notify(scope, { type: 'selection-evicted' })
    cancelSelect(scope)
  }
}

export function logFeedAndEvict(scope: TerminalDocumentScope) {
  scope.linesEverWritten++
  if (scope.initialOscLinkEvictionReady && isBufferFull(scope)) {
    scope.initialOscLinkRowOffset += 1
  }
  if (scope.selMode === 'select' && scope.sel && isBufferFull(scope)) {
    scope.sel.anchor.row -= 1
    scope.sel.focus.row -= 1
    checkEviction(scope)
    repositionOverlay(scope)
  }
}

export function startSelectionStateAndEviction(scope: TerminalDocumentScope) {
  scope.selectionOverlay = elementInRoot(scope.root, 'selection-overlay')
  scope.handleStart = elementInRoot(scope.root, 'sel-handle-start')
  scope.handleEnd = elementInRoot(scope.root, 'sel-handle-end')
  scope.selMenu = elementInRoot(scope.root, 'sel-menu')
  scope.btnCopy = elementInRoot(scope.root, 'sel-menu-copy')
  scope.btnSelAll = elementInRoot(scope.root, 'sel-menu-all')
}
