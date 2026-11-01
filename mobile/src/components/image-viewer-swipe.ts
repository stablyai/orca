// Vertical dismiss for a fitted image. Shared by the pointer stream and the viewer's motion.

/** Movement before a one-finger drag locks to an axis. */
export const IMAGE_VIEWER_SWIPE_SLOP = 10
/** Projected travel, in either direction, that closes the viewer. */
export const IMAGE_VIEWER_DISMISS_DISTANCE = 160
/** A flick at least this fast (px/s) closes even when the finger has not travelled far. */
export const IMAGE_VIEWER_DISMISS_VELOCITY = 800
/** Backdrop is fully clear once the finger has travelled this far. */
export const IMAGE_VIEWER_FADE_DISTANCE = 280
export const IMAGE_VIEWER_DISMISS_MS = 200

const RELEASE_PROJECTION_S = 0.15

export type ImageViewerSwipePhase = 'idle' | 'pending' | 'vertical' | 'horizontal' | 'pinch'

export type ImageViewerSwipe = {
  phase: ImageViewerSwipePhase
  originX: number
  originY: number
  x: number
  y: number
  translationY: number
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
    phase: atBaseZoom ? 'pending' : 'horizontal',
    originX: point.x,
    originY: point.y,
    x: point.x,
    y: point.y,
    translationY: 0,
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
  const velocityY = ((point.y - swipe.y) / dt) * 1000
  const next: ImageViewerSwipe = {
    ...swipe,
    x: point.x,
    y: point.y,
    lastT: time,
    velocityY
  }
  if (pointerCount >= 2) {
    return { ...next, phase: 'pinch', translationY: 0, velocityY: 0 }
  }
  if (swipe.phase === 'pinch' || swipe.phase === 'horizontal') {
    return next
  }
  const dx = point.x - swipe.originX
  const dy = point.y - swipe.originY
  if (swipe.phase === 'pending') {
    if (Math.hypot(dx, dy) < IMAGE_VIEWER_SWIPE_SLOP) {
      return next
    }
    // A horizontal drag is a pan, including an even diagonal, so it cannot close the viewer.
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { ...next, phase: 'horizontal' }
    }
    return { ...next, phase: 'vertical', translationY: dy }
  }
  return { ...next, translationY: dy }
}

/** True when a vertical release should finish closing instead of springing back. */
export function shouldDismissImageViewer(translationY: number, velocityY: number): boolean {
  const direction = Math.sign(translationY)
  if (direction === 0) {
    return false
  }
  const projected = translationY + velocityY * RELEASE_PROJECTION_S
  // A flick back toward rest cancels, even after a long drag.
  if (Math.sign(projected) !== direction) {
    return false
  }
  if (Math.abs(velocityY) >= IMAGE_VIEWER_DISMISS_VELOCITY && Math.sign(velocityY) === direction) {
    return true
  }
  return Math.abs(projected) >= IMAGE_VIEWER_DISMISS_DISTANCE
}

/** 1 at rest, 0 once the drag has crossed the fade distance. Symmetric up and down. */
export function imageViewerBackdropOpacity(translationY: number): number {
  if (IMAGE_VIEWER_FADE_DISTANCE <= 0) {
    return 1
  }
  return 1 - Math.min(Math.abs(translationY) / IMAGE_VIEWER_FADE_DISTANCE, 1)
}

const RELEASE_HOLD_MS = 48

/** A finger that has rested reports no flick; the last move's speed only counts while it is fresh. */
export function imageViewerReleaseVelocity(swipe: ImageViewerSwipe, time: number): number {
  return time - swipe.lastT > RELEASE_HOLD_MS ? 0 : swipe.velocityY
}

/** Off-screen translation that continues the finger's direction. */
export function imageViewerDismissTarget(translationY: number, windowHeight: number): number {
  const direction = translationY < 0 ? -1 : 1
  return direction * Math.max(windowHeight, Math.abs(translationY), 1)
}
