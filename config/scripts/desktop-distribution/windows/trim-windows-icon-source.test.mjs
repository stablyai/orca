import { describe, expect, it } from 'vitest'
import {
  cropImage,
  findOpaqueBounds,
  resizeImage,
  squareWithMargin
} from './trim-windows-icon-source.mjs'

function glyphFillFraction(image) {
  const bounds = findOpaqueBounds(image)
  if (!bounds) {
    return 0
  }
  return Math.max(bounds.width, bounds.height) / Math.max(image.width, image.height)
}

describe('trim pipeline', () => {
  function solidSquareWithInset(canvas, glyph) {
    const data = Buffer.alloc(canvas * canvas * 4)
    const offset = Math.floor((canvas - glyph) / 2)
    for (let y = 0; y < glyph; y++) {
      for (let x = 0; x < glyph; x++) {
        const idx = ((offset + y) * canvas + (offset + x)) * 4
        data[idx] = 200
        data[idx + 1] = 100
        data[idx + 2] = 50
        data[idx + 3] = 255
      }
    }
    return { width: canvas, height: canvas, data }
  }

  it('finds the opaque glyph bounds and ignores transparent inset', () => {
    const image = solidSquareWithInset(100, 60)
    const bounds = findOpaqueBounds(image)
    expect(bounds).toEqual({ minX: 20, minY: 20, maxX: 79, maxY: 79, width: 60, height: 60 })
  })

  it('downscales without leaving the glyph undersized', () => {
    const image = solidSquareWithInset(256, 200)
    const filled = squareWithMargin(cropImage(image, findOpaqueBounds(image)))
    const small = resizeImage(filled, 32, 32)
    expect(small.width).toBe(32)
    const edge = {
      width: 2,
      height: 1,
      data: Buffer.from([200, 100, 50, 255, 0, 0, 0, 0])
    }
    expect(resizeImage(edge, 1, 1).data).toEqual(Buffer.from([200, 100, 50, 128]))
    expect(glyphFillFraction(small)).toBeGreaterThanOrEqual(0.9)
  })
})
