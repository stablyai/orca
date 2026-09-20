import { repositionOverlay } from './selection-overlay'
import { cancelSelect } from './selection-range'
import { notify } from './host-notify'
import { scope } from './document-scope'

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

export function resetEvictionCounter() {
  scope.linesEverWritten = 0
}

export function isBufferFull() {
  if (!scope.term) {
    return false
  }
  return scope.linesEverWritten >= 5000 + (scope.term.rows || 0)
}

export function checkEviction() {
  if (scope.selMode !== 'select' || !scope.sel) {
    return
  }
  const oldest = Math.min(scope.sel.anchor.row, scope.sel.focus.row)
  if (oldest < 0) {
    notify({ type: 'selection-evicted' })
    cancelSelect()
  }
}

export function logFeedAndEvict() {
  scope.linesEverWritten++
  if (scope.initialOscLinkEvictionReady && isBufferFull()) {
    scope.initialOscLinkRowOffset += 1
  }
  if (scope.selMode === 'select' && scope.sel && isBufferFull()) {
    scope.sel.anchor.row -= 1
    scope.sel.focus.row -= 1
    checkEviction()
    repositionOverlay()
  }
}

export function startSelectionStateAndEviction() {
  scope.selectionOverlay = document.getElementById('selection-overlay')
  scope.handleStart = document.getElementById('sel-handle-start')
  scope.handleEnd = document.getElementById('sel-handle-end')
  scope.selMenu = document.getElementById('sel-menu')
  scope.btnCopy = document.getElementById('sel-menu-copy')
  scope.btnSelAll = document.getElementById('sel-menu-all')
}
