import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import {
  CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES,
  compressClipboardImageIfExceedsLimit
} from './clipboard-image-compression'

describe('compressClipboardImageIfExceedsLimit', () => {
  it('returns original PNG if within limit', () => {
    const pngBuffer = Buffer.alloc(1024)
    const image = {
      toPNG: () => pngBuffer,
      toJPEG: vi.fn(),
      resize: vi.fn(),
      getSize: () => ({ width: 100, height: 100 })
    } as unknown as NativeImage

    const result = compressClipboardImageIfExceedsLimit(image)
    expect(result).toBe(pngBuffer)
    expect(image.toJPEG).not.toHaveBeenCalled()
  })

  it('re-encodes to JPEG if PNG exceeds 5MB', () => {
    const pngBuffer = Buffer.alloc(CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES + 100)
    const jpegBuffer = Buffer.alloc(1024 * 1024) // 1MB
    const image = {
      toPNG: () => pngBuffer,
      toJPEG: vi.fn((quality: number) => (quality === 85 ? jpegBuffer : Buffer.alloc(500))),
      resize: vi.fn(),
      getSize: () => ({ width: 2000, height: 1500 })
    } as unknown as NativeImage

    const result = compressClipboardImageIfExceedsLimit(image)
    expect(result).toBe(jpegBuffer)
    expect(image.toJPEG).toHaveBeenCalledWith(85)
  })

  it('downscales and compresses if JPEG 70 still exceeds limit', () => {
    const pngBuffer = Buffer.alloc(CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES + 500)
    const largeJpeg = Buffer.alloc(CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES + 200)
    const downscaledJpeg = Buffer.alloc(2 * 1024 * 1024)

    const resizedImage = {
      toJPEG: vi.fn().mockReturnValue(downscaledJpeg),
      toPNG: vi.fn()
    }
    const image = {
      toPNG: () => pngBuffer,
      toJPEG: vi.fn().mockReturnValue(largeJpeg),
      resize: vi.fn().mockReturnValue(resizedImage),
      getSize: () => ({ width: 4000, height: 3000 })
    } as unknown as NativeImage

    const result = compressClipboardImageIfExceedsLimit(image)
    expect(result).toBe(downscaledJpeg)
    expect(image.resize).toHaveBeenCalled()
  })
})
