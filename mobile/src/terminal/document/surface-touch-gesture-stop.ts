import type { TerminalDocumentScope } from './document-scope'
import { cancelDocumentFrame } from './document-frame-registry'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { updateTransform } from './viewport-transform'

// Leaf module so selection mode can end gestures without importing the gesture handlers.
export function stopSurfaceTouchGestures(scope: TerminalDocumentScope) {
  const interruptedPinch = scope.touchGesture.isPinching
  scope.touchGesture.active = false
  if (scope.touchGesture.momentumId !== null) {
    cancelDocumentFrame(scope, scope.touchGesture.momentumId)
    scope.touchGesture.momentumId = null
  }
  scope.touchGesture.velY = 0
  scope.touchGesture.accumDelta = 0
  scope.touchGesture.isPinching = false
  if (interruptedPinch) {
    scope.userScale = 1
    scope.panX = 0
    scope.panY = 0
    if (scope.surface) {
      updateTransform(scope)
    }
    emitKeyboardAvoidanceMetrics(scope)
  }
}
