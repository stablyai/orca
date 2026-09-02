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

import { stampTrayDevBadge } from './tray-dev-badge'

function fakeTemplate(width: number, height: number) {
  // All-transparent base so any opaque pixel in the result is the badge.
  return {
    getSize: () => ({ width, height }),
    toBitmap: vi.fn((options?: { scaleFactor?: number }) => {
      const scale = options?.scaleFactor ?? 1
      return Buffer.alloc(width * scale * height * scale * 4, 0)
    })
  }
}

describe('stampTrayDevBadge', () => {
  it('returns the base unchanged when it has no pixels', () => {
    createFromBitmapMock.mockClear()
    const base = { getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) }

    expect(stampTrayDevBadge(base as never)).toBe(base)
    expect(createFromBitmapMock).not.toHaveBeenCalled()
  })

  it('keeps the template canvas size and stamps opaque template-black pixels', () => {
    createFromBitmapMock.mockClear()
    const width = 22
    const height = 14
    stampTrayDevBadge(fakeTemplate(width, height) as never)

    const [bitmap, options] = createFromBitmapMock.mock.calls[0]
    expect(options).toEqual({ width, height })

    let stamped = 0
    let maxX = 0
    let maxY = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        if (bitmap[o + 3] === 0xff) {
          expect([bitmap[o], bitmap[o + 1], bitmap[o + 2]]).toEqual([0x00, 0x00, 0x00])
          stamped++
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
        }
      }
    }
    expect(stamped).toBeGreaterThan(0)
    // The badge occupies the lower-left area and never spills off canvas.
    expect(maxX).toBeLessThan(width)
    expect(maxY).toBeLessThan(height)
  })

  it('reads and scales the requested Retina representation', () => {
    const opaque = (buffer: Buffer): number => {
      let count = 0
      for (let o = 3; o < buffer.length; o += 4) {
        if (buffer[o] === 0xff) {
          count++
        }
      }
      return count
    }

    createFromBitmapMock.mockClear()
    const base = fakeTemplate(22, 14)
    stampTrayDevBadge(base as never, 2)
    expect(base.toBitmap).toHaveBeenCalledWith({ scaleFactor: 2 })
    const [bitmap2x, options2x] = createFromBitmapMock.mock.calls[0]
    expect(options2x).toEqual({ width: 44, height: 28 })

    createFromBitmapMock.mockClear()
    stampTrayDevBadge(fakeTemplate(22, 14) as never, 1)
    const [bitmap1x] = createFromBitmapMock.mock.calls[0]

    // Each 1x badge pixel becomes a 2x2 block, so the @2x stamp has 4x the area.
    expect(opaque(bitmap2x)).toBe(opaque(bitmap1x) * 4)
  })
})
