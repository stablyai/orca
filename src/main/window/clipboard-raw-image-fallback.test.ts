import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'

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
