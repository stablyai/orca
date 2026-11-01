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
  // Transparent base isolates pixels contributed by the attention dot/ring.
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(width * height * 4, 0)
  }
}

// Electron bitmaps use BGRA; renderer attention token is amber-500 (#f59e0b).
const AMBER = { b: 0x0b, g: 0x9e, r: 0xf5 }

describe('composeTrayAttentionIcon', () => {
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
    expect(sumX / amberCount).toBeGreaterThan(width / 2)
    expect(sumY / amberCount).toBeLessThan(height / 2)
    expect(paintedInBottomLeft).toBe(0)
  })
})

describe('tintTrayTemplateForAttention', () => {
  it('keeps white edge pixels premultiplied-valid at partial alpha', () => {
    createFromBitmapMock.mockClear()
    const base = {
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([0x00, 0x00, 0x00, 0x80])
    }

    tintTrayTemplateForAttention(base as never, true)

    // Premultiplied alpha requires 0x80 channels for half-covered white, not 0xff.
    expect(createFromBitmapMock.mock.calls[0][0]).toEqual(Buffer.from([0x80, 0x80, 0x80, 0x80]))
  })
})
