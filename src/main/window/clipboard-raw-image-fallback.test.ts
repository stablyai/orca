import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'

import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../shared/clipboard-image'
import { readClipboardRawImageAsPng } from './clipboard-raw-image-fallback'

function makeClipboard(formats: string[], buffers: Record<string, Buffer>) {
  return {
    availableFormats: vi.fn(() => formats),
    readBuffer: vi.fn((format: string) => buffers[format] ?? Buffer.alloc(0))
  }
}

describe('readClipboardRawImageAsPng', () => {
  it('converts the first decodable raw image flavor to PNG', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const png = Buffer.from([9, 8, 7])
    const clipboard = makeClipboard(['image/jpeg', 'image/png'], { 'image/jpeg': jpeg })

    expect(
      readClipboardRawImageAsPng(clipboard, {
        createImageFromBuffer: (buffer) =>
          buffer === jpeg ? decodableImage(() => png) : emptyImage()
      })
    ).toBe(png)
  })

  it('skips flavors that are absent, empty, or undecodable', () => {
    const junk = Buffer.from([1, 2, 3])
    const clipboard = makeClipboard(['image/png', 'image/jpeg'], { 'image/png': junk })
    const created: Buffer[] = []
    const result = readClipboardRawImageAsPng(clipboard, {
      createImageFromBuffer: (buffer) => {
        created.push(buffer)
        if (buffer === junk) {
          throw new Error('undecodable')
        }
        return emptyImage()
      }
    })

    expect(result).toBeNull()
    expect(created).toEqual([junk])
  })

  it('propagates oversized decoded dimensions', () => {
    const huge = Buffer.from([0, 1, 2, 3])
    const clipboard = makeClipboard(['image/png'], { 'image/png': huge })
    expect(() =>
      readClipboardRawImageAsPng(clipboard, {
        createImageFromBuffer: () =>
          ({
            isEmpty: () => false,
            getSize: () => ({ height: 1, width: 32 * 1024 * 1024 + 1 })
          }) as never
      })
    ).toThrow('Clipboard image is too large')
  })

  it('refuses an oversized flavor buffer before decoding', () => {
    const oversized = Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)
    const clipboard = makeClipboard(['image/png'], { 'image/png': oversized })
    const decode = vi.fn(() => decodableImage(() => Buffer.from([1])))
    expect(() => readClipboardRawImageAsPng(clipboard, { createImageFromBuffer: decode })).toThrow(
      'Clipboard image is too large'
    )
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects a pixel bomb from encoded metadata before the decoder allocates', () => {
    // PNG header declaring 32768x1025 (over the 32M pixel budget) in 24 bytes.
    const bomb = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bomb, 0)
    bomb.writeUInt32BE(13, 8)
    bomb.write('IHDR', 12, 'ascii')
    bomb.writeUInt32BE(32768, 16)
    bomb.writeUInt32BE(1025, 20)
    const clipboard = makeClipboard(['image/png'], { 'image/png': bomb })
    const decode = vi.fn(() => decodableImage(() => Buffer.from([1])))
    expect(() => readClipboardRawImageAsPng(clipboard, { createImageFromBuffer: decode })).toThrow(
      'Clipboard image is too large'
    )
    expect(decode).not.toHaveBeenCalled()
  })

  it('still decodes a TIFF flavor that has no encoded dimensions', () => {
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])
    const png = Buffer.from([7, 8, 9])
    const clipboard = makeClipboard(['image/tiff'], { 'image/tiff': tiff })
    expect(
      readClipboardRawImageAsPng(clipboard, {
        createImageFromBuffer: (buffer) =>
          buffer === tiff ? decodableImage(() => png) : emptyImage()
      })
    ).toBe(png)
  })
})

function decodableImage(toPNG: () => Buffer): NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ height: 2, width: 3 }),
    toPNG
  } as never
}

function emptyImage(): NativeImage {
  return { isEmpty: () => true } as never
}
