import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { repositionOverlay, stopEdgeScroll } from './selection-overlay'
import { seedWordSelection } from './selection-range'
import { resetSmoothScrollOffset } from './normal-buffer-smooth-scroll'
import { stopSurfaceTouchGestures } from './surface-touch-gestures'

// Keep overlay transitions outside range math to avoid an overlay import cycle.

export function cancelSelect(scope: TerminalDocumentScope) {
  scope.selMode = 'navigate'
  scope.sel = null
  stopEdgeScroll(scope)
  if (scope.term) {
    try {
      scope.term.clearSelection()
    } catch {}
    // Some renderers cache highlights after clearSelection; refresh all rows to repaint the cleared layer.
    try {
      scope.term.refresh(0, scope.term.rows - 1)
    } catch {}
  }
  scope.selectionOverlay!.classList.remove('active')
  notify(scope, { type: 'set-select-mode', enabled: false })
}

export function enterSelect(scope: TerminalDocumentScope, col: number, absRow: number) {
  stopSurfaceTouchGestures(scope)
  resetSmoothScrollOffset(scope)
  scope.selMode = 'select'
  seedWordSelection(scope, col, absRow)
  scope.selectionOverlay!.classList.add('active')
  notify(scope, { type: 'set-select-mode', enabled: true })
  notify(scope, { type: 'haptic', kind: 'selection' })
  repositionOverlay(scope)
}
