import { describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../shared/clipboard-image'
import { readWindowsClipboardImageFileAsPng } from './clipboard-windows-image-file'

function image(png = Buffer.from([1, 2, 3])) {
  return {
    getSize: () => ({ height: 10, width: 10 }),
    isEmpty: () => false,
    toPNG: () => png
  }
}

describe('readWindowsClipboardImageFileAsPng', () => {
  it('converts a copied Windows image file to bounded PNG bytes', async () => {
    const filePath = 'C:\\Users\\alice\\图片\\shot.PNG'
    const png = Buffer.from([4, 3, 2, 1])
    const readClipboardFormatBuffer = vi.fn(() => Buffer.from(`${filePath}\0`, 'utf16le'))
    const statFile = vi.fn(async () => ({ isFile: () => true, size: 1024 }))
    const createImageFromPath = vi.fn(() => image(png) as never)

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormatBuffer,
        statFile,
        createImageFromPath
      })
    ).resolves.toEqual(png)

    expect(readClipboardFormatBuffer).toHaveBeenCalledWith('FileNameW')
    expect(statFile).toHaveBeenCalledWith(filePath)
    expect(createImageFromPath).toHaveBeenCalledWith(filePath)
  })

  it('ignores copied files outside Windows and unsupported file types', async () => {
    const statFile = vi.fn()
    const createImageFromPath = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'linux',
        readClipboardFormatBuffer: vi.fn(() => Buffer.from('/tmp/shot.png\0', 'utf16le')),
        statFile,
        createImageFromPath
      })
    ).resolves.toBeNull()
    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormatBuffer: vi.fn(() =>
          Buffer.from('C:\\Users\\alice\\notes.txt\0', 'utf16le')
        ),
        statFile,
        createImageFromPath
      })
    ).resolves.toBeNull()

    expect(statFile).not.toHaveBeenCalled()
    expect(createImageFromPath).not.toHaveBeenCalled()
  })

  it('rejects embedded nulls instead of treating multiple paths as one file', async () => {
    const statFile = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormatBuffer: vi.fn(() =>
          Buffer.from('C:\\Users\\alice\\one.png\0C:\\Users\\alice\\two.png\0', 'utf16le')
        ),
        statFile,
        createImageFromPath: vi.fn()
      })
    ).resolves.toBeNull()

    expect(statFile).not.toHaveBeenCalled()
  })

  it('rejects oversized source files before decoding them', async () => {
    const createImageFromPath = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormatBuffer: vi.fn(() =>
          Buffer.from('C:\\Users\\alice\\huge.png\0', 'utf16le')
        ),
        statFile: vi.fn(async () => ({
          isFile: () => true,
          size: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1
        })),
        createImageFromPath
      })
    ).rejects.toThrow('Clipboard image is too large')

    expect(createImageFromPath).not.toHaveBeenCalled()
  })

  it('ignores clipboard files that disappeared before paste', async () => {
    const createImageFromPath = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormatBuffer: vi.fn(() =>
          Buffer.from('C:\\Users\\alice\\missing.png\0', 'utf16le')
        ),
        statFile: vi.fn(async () => {
          throw new Error('ENOENT')
        }),
        createImageFromPath
      })
    ).resolves.toBeNull()

    expect(createImageFromPath).not.toHaveBeenCalled()
  })
})
