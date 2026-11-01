import { elementInRoot } from './document-host-seams'
import { repositionOverlay } from './selection-overlay'
import { cancelSelect } from './selection-mode'
import { notify } from './host-notify'
import type { TerminalDocumentScope } from './document-scope'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../src/shared/terminal-scrollback-policy'

// Tap slop must exceed long-press slop so small finger jitter can cancel selection without dropping link/path taps.

// Track taps independently so cancelling long press cannot discard a valid short, jittery tap.

// Once scrollback fills, each line feed evicts a row; shift stored absolute selections with it.

export function resetEvictionCounter(scope: TerminalDocumentScope) {
  scope.linesEverWritten = 0
}

export function isBufferFull(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return false
  }
  return scope.linesEverWritten >= DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT + (scope.term.rows || 0)
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
