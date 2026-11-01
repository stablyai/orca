import { describe, expect, it } from 'vitest'
import {
  IMAGE_VIEWER_DISMISS_DISTANCE,
  IMAGE_VIEWER_DISMISS_VELOCITY,
  IMAGE_VIEWER_FADE_DISTANCE,
  IMAGE_VIEWER_SWIPE_SLOP,
  beginImageViewerSwipe,
  imageViewerBackdropOpacity,
  imageViewerDismissTarget,
  imageViewerReleaseVelocity,
  moveImageViewerSwipe,
  shouldDismissImageViewer
} from './image-viewer-swipe'

describe('image viewer swipe', () => {
  it('stays undecided inside the slop, then follows the finger in any direction', () => {
    let swipe = beginImageViewerSwipe({ x: 10, y: 20 }, 0, true)
    swipe = moveImageViewerSwipe(swipe, { x: 14, y: 20 + IMAGE_VIEWER_SWIPE_SLOP - 1 }, 16, 1)
    expect(swipe.phase).toBe('pending')
    expect(swipe.translationX).toBe(0)
    expect(swipe.translationY).toBe(0)

    const horizontal = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 40, y: 12 },
      20,
      1
    )
    expect(horizontal.phase).toBe('tracking')
    expect(horizontal.translationX).toBe(40)
    expect(horizontal.translationY).toBe(12)

    const diagonal = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: -30, y: -30 },
      20,
      1
    )
    expect(diagonal.phase).toBe('tracking')
    expect(diagonal.translationX).toBe(-30)
    expect(diagonal.translationY).toBe(-30)
  })

  it('keeps a zoomed pan and a pinch off the dismiss path', () => {
    const zoomed = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, false),
      { x: 80, y: 40 },
      30,
      1
    )
    expect(zoomed.phase).toBe('pan')
    expect(zoomed.translationX).toBe(0)
    expect(zoomed.translationY).toBe(0)

    let swipe = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 30, y: 10 },
      20,
      1
    )
    expect(swipe.phase).toBe('tracking')
    swipe = moveImageViewerSwipe(swipe, { x: 36, y: 18 }, 40, 2)
    expect(swipe.phase).toBe('pinch')
    expect(swipe.translationX).toBe(0)
    expect(swipe.translationY).toBe(0)
  })

  it('reports the latest speed, and a pause is not a flick', () => {
    const swipe = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 30, y: 40 },
      50,
      1
    )
    expect(swipe.velocityX).toBe(600)
    expect(swipe.velocityY).toBe(800)
    expect(imageViewerReleaseVelocity(swipe, 50)).toEqual({ x: 600, y: 800 })
    expect(imageViewerReleaseVelocity(swipe, 120)).toEqual({ x: 0, y: 0 })
  })
})

describe('image viewer dismiss release', () => {
  it('closes on distance or a flick in any direction, and stays when the finger heads back', () => {
    expect(shouldDismissImageViewer(IMAGE_VIEWER_DISMISS_DISTANCE, 0, 0, 0)).toBe(true)
    expect(shouldDismissImageViewer(-IMAGE_VIEWER_DISMISS_DISTANCE, 0, 0, 0)).toBe(true)
    expect(shouldDismissImageViewer(0, IMAGE_VIEWER_DISMISS_DISTANCE, 0, 0)).toBe(true)
    expect(shouldDismissImageViewer(0, -IMAGE_VIEWER_DISMISS_DISTANCE, 0, 0)).toBe(true)
    const diagonal = IMAGE_VIEWER_DISMISS_DISTANCE / Math.SQRT2
    expect(shouldDismissImageViewer(diagonal, diagonal, 0, 0)).toBe(true)
    expect(shouldDismissImageViewer(IMAGE_VIEWER_DISMISS_DISTANCE - 40, 0, 0, 0)).toBe(false)
    expect(shouldDismissImageViewer(24, 0, IMAGE_VIEWER_DISMISS_VELOCITY, 0)).toBe(true)
    expect(shouldDismissImageViewer(0, -24, 0, -IMAGE_VIEWER_DISMISS_VELOCITY)).toBe(true)
    expect(
      shouldDismissImageViewer(18, 18, IMAGE_VIEWER_DISMISS_VELOCITY, IMAGE_VIEWER_DISMISS_VELOCITY)
    ).toBe(true)
    expect(shouldDismissImageViewer(24, 0, 100, 0)).toBe(false)
    // A long drag flung back toward rest stays open.
    expect(shouldDismissImageViewer(220, 0, -IMAGE_VIEWER_DISMISS_VELOCITY * 3, 0)).toBe(false)
    expect(shouldDismissImageViewer(0, 0, IMAGE_VIEWER_DISMISS_VELOCITY, 0)).toBe(false)
  })

  it('fades the backdrop with distance from rest', () => {
    expect(imageViewerBackdropOpacity(0, 0)).toBe(1)
    expect(imageViewerBackdropOpacity(IMAGE_VIEWER_FADE_DISTANCE / 2, 0)).toBeCloseTo(0.5)
    expect(imageViewerBackdropOpacity(0, -IMAGE_VIEWER_FADE_DISTANCE / 2)).toBeCloseTo(0.5)
    const half = IMAGE_VIEWER_FADE_DISTANCE / 2 / Math.SQRT2
    expect(imageViewerBackdropOpacity(half, half)).toBeCloseTo(0.5)
    expect(imageViewerBackdropOpacity(IMAGE_VIEWER_FADE_DISTANCE, 0)).toBe(0)
    expect(imageViewerBackdropOpacity(IMAGE_VIEWER_FADE_DISTANCE + 40, 20)).toBe(0)
  })

  it('leaves the screen along the drag', () => {
    expect(imageViewerDismissTarget(40, 0, 390, 800)).toEqual({ x: 800, y: 0 })
    expect(imageViewerDismissTarget(0, -12, 390, 800)).toEqual({ x: 0, y: -800 })
    expect(imageViewerDismissTarget(900, 0, 390, 800)).toEqual({ x: 900, y: 0 })
    const diagonal = imageViewerDismissTarget(30, 40, 300, 400)
    expect(diagonal.x).toBeCloseTo(240)
    expect(diagonal.y).toBeCloseTo(320)
  })
})
