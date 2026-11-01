// Any-direction dismiss for a fitted image. Shared by the pointer stream and the viewer's motion.

/** Movement before a one-finger drag starts following the finger. */
export const IMAGE_VIEWER_SWIPE_SLOP = 10
/** Projected travel, in any direction, that closes the viewer. */
export const IMAGE_VIEWER_DISMISS_DISTANCE = 160
/** A flick at least this fast (px/s) closes even when the finger has not travelled far. */
export const IMAGE_VIEWER_DISMISS_VELOCITY = 800
/** Backdrop is fully clear once the finger has travelled this far. */
export const IMAGE_VIEWER_FADE_DISTANCE = 280
export const IMAGE_VIEWER_DISMISS_MS = 200

const RELEASE_PROJECTION_S = 0.15
const RELEASE_HOLD_MS = 48

export type ImageViewerSwipePhase = 'idle' | 'pending' | 'tracking' | 'pan' | 'pinch'

export type ImageViewerSwipe = {
  phase: ImageViewerSwipePhase
  originX: number
  originY: number
  x: number
  y: number
  translationX: number
  translationY: number
  velocityX: number
  velocityY: number
  lastT: number
}

type Point = { x: number; y: number }

export function beginImageViewerSwipe(
  point: Point,
  time: number,
  atBaseZoom: boolean
): ImageViewerSwipe {
  return {
    // Zoomed content keeps its pan; only the fitted image can leave with the finger.
    phase: atBaseZoom ? 'pending' : 'pan',
    originX: point.x,
    originY: point.y,
    x: point.x,
    y: point.y,
    translationX: 0,
    translationY: 0,
    velocityX: 0,
    velocityY: 0,
    lastT: time
  }
}

export function moveImageViewerSwipe(
  swipe: ImageViewerSwipe,
  point: Point,
  time: number,
  pointerCount: number
): ImageViewerSwipe {
  if (swipe.phase === 'idle') {
    return swipe
  }
  const dt = Math.max(time - swipe.lastT, 1)
  const velocityX = ((point.x - swipe.x) / dt) * 1000
  const velocityY = ((point.y - swipe.y) / dt) * 1000
  const next: ImageViewerSwipe = {
    ...swipe,
    x: point.x,
    y: point.y,
    lastT: time,
    velocityX,
    velocityY
  }
  if (pointerCount >= 2) {
    return { ...next, phase: 'pinch', translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 }
  }
  if (swipe.phase === 'pinch' || swipe.phase === 'pan') {
    return next
  }
  const dx = point.x - swipe.originX
  const dy = point.y - swipe.originY
  if (swipe.phase === 'pending' && Math.hypot(dx, dy) < IMAGE_VIEWER_SWIPE_SLOP) {
    return next
  }
  return { ...next, phase: 'tracking', translationX: dx, translationY: dy }
}

/** True when a release in any direction should finish closing instead of springing back. */
export function shouldDismissImageViewer(
  translationX: number,
  translationY: number,
  velocityX: number,
  velocityY: number
): boolean {
  if (translationX === 0 && translationY === 0) {
    return false
  }
  const projectedX = translationX + velocityX * RELEASE_PROJECTION_S
  const projectedY = translationY + velocityY * RELEASE_PROJECTION_S
  // A flick back toward rest cancels, even after a long drag.
  if (translationX * projectedX + translationY * projectedY <= 0) {
    return false
  }
  const speed = Math.hypot(velocityX, velocityY)
  if (
    speed >= IMAGE_VIEWER_DISMISS_VELOCITY &&
    translationX * velocityX + translationY * velocityY > 0
  ) {
    return true
  }
  return Math.hypot(projectedX, projectedY) >= IMAGE_VIEWER_DISMISS_DISTANCE
}

/** 1 at rest, 0 once the drag has crossed the fade distance. */
export function imageViewerBackdropOpacity(translationX: number, translationY: number): number {
  if (IMAGE_VIEWER_FADE_DISTANCE <= 0) {
    return 1
  }
  return 1 - Math.min(Math.hypot(translationX, translationY) / IMAGE_VIEWER_FADE_DISTANCE, 1)
}

/** A finger that has rested reports no flick; the last move's speed only counts while it is fresh. */
export function imageViewerReleaseVelocity(
  swipe: ImageViewerSwipe,
  time: number
): { x: number; y: number } {
  return time - swipe.lastT > RELEASE_HOLD_MS
    ? { x: 0, y: 0 }
    : { x: swipe.velocityX, y: swipe.velocityY }
}

/** Off-screen translation that continues the finger's direction. */
export function imageViewerDismissTarget(
  translationX: number,
  translationY: number,
  windowWidth: number,
  windowHeight: number
): { x: number; y: number } {
  const distance = Math.hypot(translationX, translationY)
  if (distance === 0) {
    return { x: 0, y: 0 }
  }
  // The window diagonal is the farthest a full-screen stage must travel to leave in any direction.
  const span = Math.max(Math.hypot(windowWidth, windowHeight), distance, 1)
  return { x: (translationX / distance) * span, y: (translationY / distance) * span }
}
