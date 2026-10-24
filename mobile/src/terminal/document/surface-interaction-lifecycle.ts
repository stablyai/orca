import type { TerminalDocumentScope } from './document-scope'
import { stopSurfaceTouchGestures } from './surface-touch-gestures'
import { resetSmoothScrollOffset } from './normal-buffer-smooth-scroll'
import { clearLongPress } from './tap-dispatch'
import { stopEdgeScroll } from './selection-overlay'

export function suspendSurfaceTouchGestures(scope: TerminalDocumentScope) {
  stopSurfaceTouchGestures(scope)
  resetSmoothScrollOffset(scope)
  clearLongPress(scope)
  stopEdgeScroll(scope)
  scope.tapCandidate = null
  scope.mouseGesture = null
  scope.wheelAccumDeltaY = 0
  scope.touchGesture.velY = 0
  scope.touchGesture.accumDelta = 0
  scope.touchGesture.isPinching = false
  scope.touchDispatch = {
    mode: 'idle',
    touchId: null,
    touchIds: null,
    longPressFingerInsideOverlay: false
  }
  if (scope.sel) {
    scope.sel.activeHandle = null
  }
}
