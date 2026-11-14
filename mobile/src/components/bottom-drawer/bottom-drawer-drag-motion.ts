// Sheet geometry from its one progress value: 1 is open at rest, 0 is parked below the screen.
// Plain worklets so gesture callbacks can call them on the UI thread natively and on JS in pages.

// The sheet travels its own height plus this, not the whole screen, so short sheets don't rush.
const OFFSCREEN_MARGIN = 48
// Damp upward pull so the sheet signals it cannot grow further.
const RUBBER_BAND_FACTOR = 0.25
// How far ahead of release the sheet's resting place is judged, like iOS's projected offset.
const RELEASE_PROJECTION_S = 0.15
// A fast downward flick closes whatever the distance.
const FLICK_VELOCITY = 800
// Tall sheets close past this much projected drag rather than half their height.
const DISMISS_DISTANCE_CAP = 200
const MIN_DISMISS_MS = 160
// The dismiss curve's first control point: its start slope is y1 / x1, so y1 = slope * x1 starts
// the close at the finger's speed, and the curve can start no steeper than 1 / x1.
const DISMISS_CURVE_X1 = 0.3

export function bottomDrawerTravel(sheetHeight: number, screenHeight: number): number {
  'worklet'
  return Math.min(sheetHeight + OFFSCREEN_MARGIN, screenHeight)
}

/** Pixels below the open position; negative while pulled up past it. */
export function bottomDrawerOffset(progress: number, travel: number): number {
  'worklet'
  return (1 - Math.max(progress, 0)) * travel
}

/** The scrim follows the sheet's visible part, so it is gone exactly when the sheet is. */
export function bottomDrawerScrim(progress: number, travel: number, sheetHeight: number): number {
  'worklet'
  if (sheetHeight <= 0) {
    return Math.min(Math.max(progress, 0), 1)
  }
  const visible = 1 - bottomDrawerOffset(progress, travel) / sheetHeight
  return Math.min(Math.max(visible, 0), 1)
}

/** Progress for a finger `dragOffset` pixels below the open position. */
export function bottomDrawerDragProgress(dragOffset: number, travel: number): number {
  'worklet'
  const offset = dragOffset >= 0 ? dragOffset : dragOffset * RUBBER_BAND_FACTOR
  return travel > 0 ? 1 - offset / travel : 1
}

export function shouldDismissBottomDrawer(
  offset: number,
  velocityY: number,
  sheetHeight: number
): boolean {
  'worklet'
  if (velocityY > FLICK_VELOCITY) {
    return true
  }
  const projected = offset + velocityY * RELEASE_PROJECTION_S
  return projected > Math.min(sheetHeight / 2, DISMISS_DISTANCE_CAP)
}

/**
 * A swipe-away that leaves at the finger's speed: a slow release starts slow and speeds up, a
 * throw is shortened so it never starts faster than it was thrown. Returns the duration and the
 * first control point of a `bezier(x1, y1, 0.2, 1)` curve.
 */
export function bottomDrawerDismissMotion(
  offset: number,
  velocityY: number,
  travel: number,
  hideDurationMs: number
): { duration: number; x1: number; y1: number } {
  'worklet'
  const remaining = Math.max(travel - offset, 1)
  const speed = Math.max(velocityY, 0)
  const steepest = ((remaining / DISMISS_CURVE_X1) * 1000) / Math.max(speed, 1)
  const duration = Math.max(Math.min(hideDurationMs, steepest), MIN_DISMISS_MS)
  const startSlope = (speed * duration) / 1000 / remaining
  return { duration, x1: DISMISS_CURVE_X1, y1: Math.min(startSlope * DISMISS_CURVE_X1, 1) }
}
