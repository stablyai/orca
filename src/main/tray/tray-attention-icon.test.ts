import { describe, expect, it, vi } from 'vitest'

const createFromBitmapMock = vi.hoisted(() =>
  vi.fn((buffer: Buffer, options: { width: number; height: number }) => ({
    __image: true,
    buffer,
    ...options
  }))
)

vi.mock('electron', () => ({
  nativeImage: { createFromBitmap: createFromBitmapMock }
}))

import { composeTrayAttentionIcon, tintTrayTemplateForAttention } from './tray-attention-icon'

type FakeImage = {
  getSize: () => { width: number; height: number }
  toBitmap: () => Buffer
}

function fakeBase(width: number, height: number): FakeImage {
  // All-transparent base so any non-zero pixel in the result is the dot/ring.
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(width * height * 4, 0)
  }
}

// The compositor receives BGRA. amber-500 = #f59e0b.
const AMBER = { b: 0x0b, g: 0x9e, r: 0xf5 }

describe('composeTrayAttentionIcon', () => {
  it('returns the base unchanged when it has no pixels', () => {
    const base = { getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) }

    expect(composeTrayAttentionIcon(base as never)).toBe(base)
    expect(createFromBitmapMock).not.toHaveBeenCalled()
  })

  it('builds a new image of the same size', () => {
    createFromBitmapMock.mockClear()
    const result = composeTrayAttentionIcon(fakeBase(16, 16) as never)

    expect(createFromBitmapMock).toHaveBeenCalledTimes(1)
    const [, options] = createFromBitmapMock.mock.calls[0]
    expect(options).toEqual({ width: 16, height: 16 })
    expect(result).toMatchObject({ __image: true, width: 16, height: 16 })
  })

  it('paints an amber dot in the top-right corner and leaves the rest untouched', () => {
    createFromBitmapMock.mockClear()
    const width = 16
    const height = 16
    composeTrayAttentionIcon(fakeBase(width, height) as never)
    const bitmap = createFromBitmapMock.mock.calls[0][0]

    const pixel = (x: number, y: number): [number, number, number, number] => {
      const o = (y * width + x) * 4
      return [bitmap[o], bitmap[o + 1], bitmap[o + 2], bitmap[o + 3]]
    }

    // The dot must exist, be centered in the top-right, and never touch the
    // opposite (bottom-left) corner where the app glyph is most visible.
    let amberCount = 0
    let sumX = 0
    let sumY = 0
    let paintedInBottomLeft = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [b, g, r, a] = pixel(x, y)
        if (b === AMBER.b && g === AMBER.g && r === AMBER.r && a === 0xff) {
          amberCount++
          sumX += x
          sumY += y
        }
        if (a !== 0 && x < width / 2 && y >= height / 2) {
          paintedInBottomLeft++
        }
      }
    }

    expect(amberCount).toBeGreaterThan(0)
    expect(sumX / amberCount).toBeGreaterThan(width / 2) // centroid sits right of center
    expect(sumY / amberCount).toBeLessThan(height / 2) // centroid sits above center
    expect(paintedInBottomLeft).toBe(0) // the opposite corner is never touched
  })
})

describe('tintTrayTemplateForAttention', () => {
  it('preserves alpha while selecting literal black pixels for a light menu bar', () => {
    createFromBitmapMock.mockClear()
    const bitmap = Buffer.from([0x22, 0x33, 0x44, 0x80, 0xaa, 0xbb, 0xcc, 0x00])
    const base = {
      getSize: () => ({ width: 2, height: 1 }),
      toBitmap: () => bitmap
    }

    tintTrayTemplateForAttention(base as never, false)

    expect(createFromBitmapMock.mock.calls[0][0]).toEqual(
      Buffer.from([0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00])
    )
  })

  it('selects literal white pixels for a dark menu bar', () => {
    createFromBitmapMock.mockClear()
    const base = {
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([0x00, 0x00, 0x00, 0xff])
    }

    tintTrayTemplateForAttention(base as never, true)

    expect(createFromBitmapMock.mock.calls[0][0]).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  })

  it('keeps white edge pixels premultiplied-valid at partial alpha', () => {
    createFromBitmapMock.mockClear()
    const base = {
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([0x00, 0x00, 0x00, 0x80])
    }

    tintTrayTemplateForAttention(base as never, true)

    // Why: the bitmap is premultiplied — white at 50% coverage is 0x80, not 0xff.
    expect(createFromBitmapMock.mock.calls[0][0]).toEqual(Buffer.from([0x80, 0x80, 0x80, 0x80]))
  })

  it('reads and sizes the requested scale factor', () => {
    createFromBitmapMock.mockClear()
    const toBitmap = vi.fn(() => Buffer.from([0x00, 0x00, 0x00, 0xff]))
    const base = {
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap
    }

    tintTrayTemplateForAttention(base as never, true, 2)

    expect(toBitmap).toHaveBeenCalledWith({ scaleFactor: 2 })
    expect(createFromBitmapMock.mock.calls[0][1]).toEqual({ width: 2, height: 2 })
  })
})
