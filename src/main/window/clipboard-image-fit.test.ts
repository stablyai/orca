import { describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../shared/clipboard-image'
import {
  encodeClipboardImageWithinLimits,
  type FitClipboardImageSource
} from './clipboard-image-fit'

function makeImage(options: {
  width: number
  height: number
  pngBytes?: number
  resizePngBytes?: number
}): FitClipboardImageSource {
  let width = options.width
  let height = options.height
  const pngBytes = options.pngBytes ?? 16
  const resizePngBytes =
    options.resizePngBytes ?? Math.min(pngBytes, CLIPBOARD_IMAGE_MAX_SOURCE_BYTES)

  const image: FitClipboardImageSource = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(pngBytes),
    resize: vi.fn(({ width: nextWidth, height: nextHeight }) => {
      width = nextWidth
      height = nextHeight
      return {
        isEmpty: () => false,
        getSize: () => ({ width, height }),
        toPNG: () => Buffer.alloc(resizePngBytes),
        resize: image.resize
      }
    })
  }
  return image
}

describe('encodeClipboardImageWithinLimits', () => {
  it('returns the original PNG when already within limits', () => {
    const png = Buffer.from([1, 2, 3, 4])
    const image: FitClipboardImageSource = {
      isEmpty: () => false,
      getSize: () => ({ width: 10, height: 10 }),
      toPNG: () => png,
      resize: vi.fn()
    }

    expect(encodeClipboardImageWithinLimits(image)).toBe(png)
    expect(image.resize).not.toHaveBeenCalled()
  })

  it('downscales images over the pixel cap so paste can succeed', () => {
    const image = makeImage({
      width: CLIPBOARD_IMAGE_MAX_PIXELS + 1,
      height: 1,
      pngBytes: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1,
      resizePngBytes: 64
    })

    const encoded = encodeClipboardImageWithinLimits(image)
    expect(encoded.byteLength).toBe(64)
    expect(image.resize).toHaveBeenCalled()
    const firstTarget = vi.mocked(image.resize).mock.calls[0]?.[0]
    expect(firstTarget).toBeDefined()
    expect((firstTarget?.width ?? 0) * (firstTarget?.height ?? 0)).toBeLessThanOrEqual(
      CLIPBOARD_IMAGE_MAX_PIXELS
    )
  })

  it('retries encoded-size downscale when PNG bytes exceed the byte cap', () => {
    let encodeCount = 0
    let width = 4000
    let height = 3000
    const resize = vi.fn(({ width: nextWidth, height: nextHeight }) => {
      width = nextWidth
      height = nextHeight
      return image
    })
    const image: FitClipboardImageSource = {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toPNG: () => {
        encodeCount += 1
        // First encode is over the cap; subsequent encodes fit after resize.
        return Buffer.alloc(encodeCount === 1 ? CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1024 : 128)
      },
      resize
    }

    const encoded = encodeClipboardImageWithinLimits(image)
    expect(encoded.byteLength).toBe(128)
    expect(resize).toHaveBeenCalled()
  })

  it('still rejects when downscale cannot bring the payload under the cap', () => {
    const image = makeImage({
      width: 1,
      height: 1,
      pngBytes: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1,
      resizePngBytes: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1
    })

    expect(() => encodeClipboardImageWithinLimits(image)).toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  })

  it('rejects empty or invalid dimensions', () => {
    expect(() =>
      encodeClipboardImageWithinLimits({
        isEmpty: () => true,
        getSize: () => ({ width: 1, height: 1 }),
        toPNG: () => Buffer.alloc(1),
        resize: vi.fn()
      })
    ).toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)

    expect(() =>
      encodeClipboardImageWithinLimits({
        isEmpty: () => false,
        getSize: () => ({ width: 0, height: 10 }),
        toPNG: () => Buffer.alloc(1),
        resize: vi.fn()
      })
    ).toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  })
})
