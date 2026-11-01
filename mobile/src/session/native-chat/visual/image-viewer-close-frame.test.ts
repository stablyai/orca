import { describe, expect, it } from 'vitest'
import { spacing } from '../../../theme/mobile-theme'
import { imageViewerCloseFrame } from './image-viewer-close-frame'

const INNER = {
  windowWidth: 951,
  windowHeight: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }]
}
const GLYPH_CENTER = 29.33 + 37 / 2
const CLOSE_SIZE = 44

function overlaps(
  frame: { top: number; left: number; size: number | null },
  region: { x: number; y: number; width: number; height: number }
): boolean {
  const size = frame.size ?? 0
  return (
    frame.left < region.x + region.width &&
    frame.left + size > region.x &&
    frame.top < region.y + region.height &&
    frame.top + size > region.y
  )
}

describe('the image viewer close frame', () => {
  it('sits a step off the inner status row and outside the column', () => {
    const close = imageViewerCloseFrame(INNER)
    expect(close.top).toBe(GLYPH_CENTER - CLOSE_SIZE / 2 + spacing.sm)
    expect(close.left).toBe(spacing.lg + spacing.sm)
    expect(close.size).toBe(CLOSE_SIZE)
    expect(close.left + CLOSE_SIZE).toBeLessThan(INNER.windowWidth - 84)
    expect(overlaps(close, INNER.occlusions[0]!)).toBe(false)
  })

  it('clears the cover camera and the status column', () => {
    const glyph = { x: 399.67, y: 29.33, width: 37, height: 37 }
    const column = { x: 382, y: 0, width: 84, height: 174 }
    const close = imageViewerCloseFrame({
      windowWidth: 466,
      windowHeight: 678,
      insets: { top: 0, right: 84, bottom: 34, left: 0 },
      occlusions: [glyph, column]
    })
    expect(close.top).toBe(glyph.y + glyph.height / 2 - CLOSE_SIZE / 2 + spacing.sm)
    expect(close.left).toBe(spacing.lg + spacing.sm)
    expect(overlaps(close, glyph)).toBe(false)
    expect(overlaps(close, column)).toBe(false)
  })

  it('stays on the content side of a turned column', () => {
    const occlusion = { x: 0, y: 545, width: 84, height: 124 }
    const close = imageViewerCloseFrame({
      windowWidth: 951,
      windowHeight: 669,
      insets: { top: 0, right: 0, bottom: 34, left: 84 },
      occlusions: [occlusion]
    })
    expect(close.top).toBe(669 - GLYPH_CENTER - CLOSE_SIZE / 2 - spacing.sm)
    expect(close.left).toBe(84 + spacing.lg + spacing.sm)
    expect(overlaps(close, occlusion)).toBe(false)
  })

  it('keeps a phone cutout on the left', () => {
    expect(
      imageViewerCloseFrame({
        windowWidth: 390,
        windowHeight: 844,
        insets: { top: 12, right: 0, bottom: 21, left: 47 },
        occlusions: []
      })
    ).toEqual({ top: 12 + spacing.sm, left: 47 + spacing.lg, size: null })
  })
})
