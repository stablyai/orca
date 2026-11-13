import { describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_MAX_PIXELS } from '../../../shared/clipboard-image'
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
})
