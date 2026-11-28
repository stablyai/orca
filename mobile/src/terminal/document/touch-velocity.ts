import type { TerminalDocumentScope } from './document-scope'

export function updateTouchVelocity(scope: TerminalDocumentScope, deltaY: number, dt: number) {
  if (dt <= 0) {
    return
  }
  const instantVelocity = deltaY / dt
  if (!Number.isFinite(instantVelocity)) {
    return
  }
  // Smooth uneven WebView event cadence so momentum does not inherit a one-frame spike or pause.
  scope.touchGesture.velY =
    scope.touchGesture.velY === 0
      ? instantVelocity
      : scope.touchGesture.velY * 0.55 + instantVelocity * 0.45
}
