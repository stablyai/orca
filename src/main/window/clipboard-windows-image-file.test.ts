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
    const filePath = 'C:\\Users\\alice\\Pictures\\shot.PNG'
    const png = Buffer.from([4, 3, 2, 1])
    const readClipboardFormat = vi.fn(() => `${filePath}\0`)
    const statFile = vi.fn(async () => ({ isFile: () => true, size: 1024 }))
    const createImageFromPath = vi.fn(() => image(png) as never)

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormat,
        statFile,
        createImageFromPath
      })
    ).resolves.toEqual(png)

    expect(readClipboardFormat).toHaveBeenCalledWith('FileNameW')
    expect(statFile).toHaveBeenCalledWith(filePath)
    expect(createImageFromPath).toHaveBeenCalledWith(filePath)
  })

  it('ignores copied files outside Windows and unsupported file types', async () => {
    const statFile = vi.fn()
    const createImageFromPath = vi.fn()

    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'linux',
        readClipboardFormat: vi.fn(() => '/tmp/shot.png'),
        statFile,
        createImageFromPath
      })
    ).resolves.toBeNull()
    await expect(
      readWindowsClipboardImageFileAsPng({
        platform: 'win32',
        readClipboardFormat: vi.fn(() => 'C:\\Users\\alice\\notes.txt\0'),
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
        readClipboardFormat: vi.fn(() => 'C:\\Users\\alice\\one.png\0C:\\Users\\alice\\two.png\0'),
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
        readClipboardFormat: vi.fn(() => 'C:\\Users\\alice\\huge.png\0'),
        statFile: vi.fn(async () => ({
          isFile: () => true,
          size: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1
        })),
        createImageFromPath
      })
    ).rejects.toThrow('Clipboard image is too large')

    expect(createImageFromPath).not.toHaveBeenCalled()
  })
})
