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

describe('image viewer swipe axis', () => {
  it('stays undecided inside the slop, then locks to the dominant axis', () => {
    let swipe = beginImageViewerSwipe({ x: 10, y: 20 }, 0, true)
    swipe = moveImageViewerSwipe(swipe, { x: 10, y: 20 + IMAGE_VIEWER_SWIPE_SLOP - 1 }, 16, 1)
    expect(swipe.phase).toBe('pending')

    const horizontal = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 40, y: 12 },
      20,
      1
    )
    expect(horizontal.phase).toBe('horizontal')
    expect(horizontal.translationY).toBe(0)

    const vertical = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 4, y: -36 },
      20,
      1
    )
    expect(vertical.phase).toBe('vertical')
    expect(vertical.translationY).toBe(-36)
  })

  it('keeps a zoomed pan and a pinch off the dismiss axis', () => {
    const zoomed = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, false),
      { x: 0, y: 80 },
      30,
      1
    )
    expect(zoomed.phase).toBe('horizontal')

    let swipe = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 0, y: 40 },
      20,
      1
    )
    expect(swipe.phase).toBe('vertical')
    swipe = moveImageViewerSwipe(swipe, { x: 8, y: 48 }, 40, 2)
    expect(swipe.phase).toBe('pinch')
    expect(swipe.translationY).toBe(0)
  })

  it('reports the latest vertical speed, and a pause is not a flick', () => {
    const swipe = moveImageViewerSwipe(
      beginImageViewerSwipe({ x: 0, y: 0 }, 0, true),
      { x: 0, y: 40 },
      50,
      1
    )
    expect(swipe.velocityY).toBe(800)
    expect(imageViewerReleaseVelocity(swipe, 50)).toBe(800)
    expect(imageViewerReleaseVelocity(swipe, 120)).toBe(0)
  })
})

describe('image viewer dismiss release', () => {
  it('closes on distance or a flick, and stays when the finger is heading back', () => {
    expect(shouldDismissImageViewer(IMAGE_VIEWER_DISMISS_DISTANCE, 0)).toBe(true)
    expect(shouldDismissImageViewer(-IMAGE_VIEWER_DISMISS_DISTANCE, 0)).toBe(true)
    expect(shouldDismissImageViewer(IMAGE_VIEWER_DISMISS_DISTANCE - 40, 0)).toBe(false)
    expect(shouldDismissImageViewer(24, IMAGE_VIEWER_DISMISS_VELOCITY)).toBe(true)
    expect(shouldDismissImageViewer(-24, -IMAGE_VIEWER_DISMISS_VELOCITY)).toBe(true)
    expect(shouldDismissImageViewer(24, 100)).toBe(false)
    // A long drag flung back toward rest stays open.
    expect(shouldDismissImageViewer(220, -IMAGE_VIEWER_DISMISS_VELOCITY * 3)).toBe(false)
    expect(shouldDismissImageViewer(0, IMAGE_VIEWER_DISMISS_VELOCITY)).toBe(false)
  })

  it('fades the backdrop with distance, the same up or down', () => {
    expect(imageViewerBackdropOpacity(0)).toBe(1)
    expect(imageViewerBackdropOpacity(IMAGE_VIEWER_FADE_DISTANCE / 2)).toBeCloseTo(0.5)
    expect(imageViewerBackdropOpacity(-IMAGE_VIEWER_FADE_DISTANCE / 2)).toBeCloseTo(0.5)
    expect(imageViewerBackdropOpacity(IMAGE_VIEWER_FADE_DISTANCE)).toBe(0)
    expect(imageViewerBackdropOpacity(IMAGE_VIEWER_FADE_DISTANCE + 40)).toBe(0)
  })

  it('leaves the screen in the direction of the drag', () => {
    expect(imageViewerDismissTarget(40, 800)).toBe(800)
    expect(imageViewerDismissTarget(-12, 800)).toBe(-800)
    expect(imageViewerDismissTarget(900, 800)).toBe(900)
  })
})
