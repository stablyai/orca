import { describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../shared/clipboard-image'
import { readWindowsClipboardImageFileAsPng } from './clipboard-windows-image-file'

function fileNameW(filePath: string): Buffer {
  return Buffer.from(`${filePath}\0`, 'utf16le')
}

function clipboardFormats(filePath: string, shellItemCount = 1) {
  const shellIdListArray = Buffer.alloc(4 + 4 * (shellItemCount + 1))
  shellIdListArray.writeUInt32LE(shellItemCount)
  return { fileNameW: fileNameW(filePath), shellIdListArray }
}

function pngHeader(width = 10, height = 10): Buffer {
  const source = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source)
  source.writeUInt32BE(13, 8)
  source.write('IHDR', 12, 'ascii')
  source.writeUInt32BE(width, 16)
  source.writeUInt32BE(height, 20)
  return source
}

function jpegHeader(width = 10, height = 10): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x02,
    0xff,
    0xc2,
    0x00,
    0x07,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff
  ])
}

function image(png = Buffer.from([4, 3, 2, 1])) {
  return {
    getSize: () => ({ height: 10, width: 10 }),
    isEmpty: () => false,
    toPNG: () => png
  }
}

function fileHandle(
  source: Buffer,
  options: { chunkSize?: number; isFile?: boolean; size?: number } = {}
) {
  const close = vi.fn().mockResolvedValue(undefined)
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = Math.min(
      Math.max(source.byteLength - position, 0),
      length,
      options.chunkSize ?? Number.POSITIVE_INFINITY
    )
    source.copy(buffer, offset, position, position + bytesRead)
    return { buffer, bytesRead }
  })
  return {
    close,
    read,
    stat: vi.fn().mockResolvedValue({
      isFile: () => options.isFile ?? true,
      size: options.size ?? source.byteLength
    })
  }
}

describe('readWindowsClipboardImageFileAsPng', () => {
  it.each([
    'C:\\Users\\alice\\图片\\shot.PNG',
    '\\\\server\\share\\shot.jpeg',
    '\\\\?\\C:\\Users\\alice\\shot.jpg',
    '\\\\?\\UNC\\server\\share\\shot.png'
  ])('decodes and converts a bounded FileNameW path: %s', async (filePath) => {
    const source = filePath.toLowerCase().endsWith('.png') ? pngHeader() : jpegHeader()
    const png = Buffer.from([9, 8, 7])
    const handle = fileHandle(source, { chunkSize: 3 })
    const openFile = vi.fn().mockResolvedValue(handle)
    const createImageFromBuffer = vi.fn(() => image(png) as never)

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats(filePath), {
        createImageFromBuffer,
        openFile
      })
    ).resolves.toEqual(png)

    expect(openFile).toHaveBeenCalledWith(filePath)
    expect(handle.read.mock.calls.length).toBeGreaterThan(1)
    expect(handle.close).toHaveBeenCalledOnce()
    expect(createImageFromBuffer).toHaveBeenCalledWith(source)
  })

  it.each([
    ['empty', Buffer.alloc(0)],
    ['odd byte count', Buffer.from([65, 0, 0])],
    ['missing terminator', Buffer.from('C:\\shot.png', 'utf16le')],
    ['relative path', fileNameW('shot.png')],
    ['drive-relative path', fileNameW('C:shot.png')],
    ['rooted drive-relative path', fileNameW('\\shot.png')],
    ['device namespace', fileNameW('\\\\.\\pipe\\shot.png')],
    ['UNC named-pipe namespace', fileNameW('\\\\server\\pipe\\shot.png')],
    ['extended UNC named-pipe namespace', fileNameW('\\\\?\\UNC\\server\\pipe\\shot.png')],
    ['multiple paths', Buffer.from('C:\\one.png\0C:\\two.png\0', 'utf16le')],
    ['unsupported image type', fileNameW('C:\\shot.webp')],
    ['oversized payload', Buffer.alloc(64 * 1024 + 2)]
  ])('ignores malformed or unsupported %s payloads', async (_name, payload) => {
    const openFile = vi.fn()
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(
        { fileNameW: payload, shellIdListArray: Buffer.alloc(0) },
        { createImageFromBuffer, openFile }
      )
    ).resolves.toBeNull()

    expect(openFile).not.toHaveBeenCalled()
    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('rejects an Explorer multi-selection when FileNameW exposes only its first path', async () => {
    const openFile = vi.fn()
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\one.png', 2), {
        createImageFromBuffer,
        openFile
      })
    ).resolves.toBeNull()

    expect(openFile).not.toHaveBeenCalled()
    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('ignores missing, inaccessible, and looping paths', async () => {
    for (const code of ['ENOENT', 'EACCES', 'ELOOP']) {
      const error = Object.assign(new Error(code), { code })
      const openFile = vi.fn().mockRejectedValue(error)

      await expect(
        readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\shot.png'), {
          createImageFromBuffer: vi.fn(),
          openFile
        })
      ).resolves.toBeNull()
    }
  })

  it('ignores directories and closes their handles', async () => {
    const handle = fileHandle(Buffer.alloc(0), { isFile: false })
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\images.png'), {
        createImageFromBuffer,
        openFile: vi.fn().mockResolvedValue(handle)
      })
    ).resolves.toBeNull()

    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('rejects oversized sources before reading or decoding', async () => {
    const handle = fileHandle(Buffer.alloc(0), {
      size: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1
    })
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\huge.png'), {
        createImageFromBuffer,
        openFile: vi.fn().mockResolvedValue(handle)
      })
    ).rejects.toThrow('Clipboard image is too large')

    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('ignores a source that changes size after handle validation', async () => {
    const handle = fileHandle(Buffer.from('grew'), { size: 3 })
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\changed.png'), {
        createImageFromBuffer,
        openFile: vi.fn().mockResolvedValue(handle)
      })
    ).resolves.toBeNull()

    expect(handle.close).toHaveBeenCalledOnce()
    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('ignores image bytes the native decoder cannot decode', async () => {
    const handle = fileHandle(Buffer.from('not-an-image'))

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\invalid.png'), {
        createImageFromBuffer: vi.fn(() => ({ isEmpty: () => true }) as never),
        openFile: vi.fn().mockResolvedValue(handle)
      })
    ).resolves.toBeNull()
  })

  it('rejects oversized encoded dimensions before native decoding', async () => {
    const handle = fileHandle(pngHeader(CLIPBOARD_IMAGE_MAX_PIXELS + 1, 1))
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\pixel-bomb.png'), {
        createImageFromBuffer,
        openFile: vi.fn().mockResolvedValue(handle)
      })
    ).rejects.toThrow('Clipboard image is too large')

    expect(createImageFromBuffer).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('bounds malformed JPEG marker scanning before native decoding', async () => {
    const source = Buffer.alloc(2 + 2 * 4097)
    source.set([0xff, 0xd8])
    for (let offset = 2; offset < source.byteLength; offset += 2) {
      source.set([0xff, 0x01], offset)
    }
    const createImageFromBuffer = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\marker-flood.jpg'), {
        createImageFromBuffer,
        openFile: vi.fn().mockResolvedValue(fileHandle(source))
      })
    ).resolves.toBeNull()

    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('bounds decoded dimensions and converted PNG bytes', async () => {
    const oversizedDimensions = fileHandle(pngHeader())
    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\wide.png'), {
        createImageFromBuffer: vi.fn(
          () =>
            ({
              getSize: () => ({ height: 1, width: CLIPBOARD_IMAGE_MAX_PIXELS + 1 }),
              isEmpty: () => false,
              toPNG: vi.fn()
            }) as never
        ),
        openFile: vi.fn().mockResolvedValue(oversizedDimensions)
      })
    ).rejects.toThrow('Clipboard image is too large')

    const oversizedPng = fileHandle(pngHeader())
    await expect(
      readWindowsClipboardImageFileAsPng(clipboardFormats('C:\\expanded.png'), {
        createImageFromBuffer: vi.fn(
          () => image(Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)) as never
        ),
        openFile: vi.fn().mockResolvedValue(oversizedPng)
      })
    ).rejects.toThrow('Clipboard image is too large')
  })
})
