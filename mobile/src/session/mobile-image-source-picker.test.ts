import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageManipulator } from 'expo-image-manipulator'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../src/shared/clipboard-image'

vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn()
}))
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn()
}))
vi.mock('expo-file-system', () => ({
  File: vi.fn()
}))
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: vi.fn() },
  SaveFormat: { PNG: 'png' }
}))

import {
  ImageLibraryPermissionError,
  pickMobileImage,
  pickMobileImages,
  MOBILE_IMAGE_DOWNSAMPLE_TARGET_BASE64,
  prepareMobileImageForUpload,
  shouldDownsampleMobileImage,
  type PickedMobileImage
} from './mobile-image-source-picker'

const granted = { granted: true } as Awaited<
  ReturnType<typeof import('expo-image-picker').requestMediaLibraryPermissionsAsync>
>
const denied = { granted: false } as typeof granted

async function collectImages(
  images: AsyncIterable<PickedMobileImage>
): Promise<PickedMobileImage[]> {
  const collected: PickedMobileImage[] = []
  for await (const image of images) {
    collected.push(image)
  }
  return collected
}

function fileFactory(
  bytes: Uint8Array,
  options?: { fileSize?: number; handleSize?: number | null; readError?: Error }
) {
  const close = vi.fn()
  const chunks = [bytes]
  const readBytes = vi.fn(() => {
    if (options?.readError) {
      throw options.readError
    }
    return chunks.shift() ?? new Uint8Array()
  })
  const open = vi.fn(() => ({
    size: options?.handleSize ?? options?.fileSize ?? bytes.length,
    readBytes,
    close
  }))
  const createFile = vi.fn(() => ({ size: options?.fileSize ?? bytes.length, open }))
  return { close, createFile, open }
}

describe('pickMobileImage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads a photo URI without relying on React Native fetch', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3])
    const file = fileFactory(bytes)
    const launchLibrary = vi.fn().mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///x.jpg', fileSize: bytes.length }]
    })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network request failed'))
    const result = await pickMobileImage('library', {
      requestLibraryPermission: vi.fn().mockResolvedValue(granted),
      launchLibrary,
      createFile: file.createFile
    })

    expect(result).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      uri: 'file:///x.jpg'
    })
    expect(launchLibrary).toHaveBeenCalledWith(expect.objectContaining({ base64: false }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('returns every selected library photo in order', async () => {
    const bytesByUri = new Map([
      ['file:///a.jpg', new Uint8Array([1])],
      ['file:///b.jpg', new Uint8Array([2])],
      ['file:///c.jpg', new Uint8Array([3])]
    ])
    const createFile = vi.fn((uri: string) => {
      const bytes = bytesByUri.get(uri)!
      let read = false
      return {
        size: bytes.length,
        open: () => ({
          size: bytes.length,
          readBytes: () => {
            if (read) {
              return new Uint8Array()
            }
            read = true
            return bytes
          },
          close: vi.fn()
        })
      }
    })
    const launchLibrary = vi.fn().mockResolvedValue({
      canceled: false,
      assets: [...bytesByUri].map(([uri, bytes]) => ({ uri, fileSize: bytes.length }))
    })

    const result = await collectImages(
      pickMobileImages('library', {
        requestLibraryPermission: vi.fn().mockResolvedValue(granted),
        launchLibrary,
        createFile
      })
    )

    expect(result.map((image) => image.uri)).toEqual([
      'file:///a.jpg',
      'file:///b.jpg',
      'file:///c.jpg'
    ])
    expect(launchLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: 0
      })
    )
  })

  it('throws when photo library permission is denied', async () => {
    await expect(
      pickMobileImage('library', {
        requestLibraryPermission: vi.fn().mockResolvedValue(denied),
        launchLibrary: vi.fn()
      })
    ).rejects.toBeInstanceOf(ImageLibraryPermissionError)
  })

  it('returns null when the library picker is cancelled', async () => {
    const result = await pickMobileImage('library', {
      requestLibraryPermission: vi.fn().mockResolvedValue(granted),
      launchLibrary: vi.fn().mockResolvedValue({ canceled: true, assets: null })
    })

    expect(result).toBeNull()
  })

  it('reads a picked file URI into base64 for the files source', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const file = fileFactory(bytes)

    const result = await pickMobileImage('files', {
      launchFiles: vi.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///doc.png', size: bytes.length }]
      }),
      createFile: file.createFile
    })

    expect(result).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      uri: 'file:///doc.png'
    })
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('returns null when the files picker is cancelled', async () => {
    const result = await pickMobileImage('files', {
      launchFiles: vi.fn().mockResolvedValue({ canceled: true, assets: null })
    })

    expect(result).toBeNull()
  })

  it('prepares an oversized asset before any raw base64 read', async () => {
    const file = fileFactory(new Uint8Array([1]))
    const prepareImage = vi.fn().mockRejectedValue(new Error('Clipboard image is too large'))
    await expect(
      pickMobileImage('files', {
        launchFiles: vi.fn().mockResolvedValue({
          canceled: false,
          assets: [{ uri: 'file:///huge.png', size: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1 }]
        }),
        createFile: file.createFile,
        prepareImage
      })
    ).rejects.toThrow('Clipboard image is too large')
    expect(file.createFile).not.toHaveBeenCalled()
    expect(file.open).not.toHaveBeenCalled()
    expect(prepareImage).toHaveBeenCalledOnce()
  })

  it('closes the file handle when reading fails', async () => {
    const file = fileFactory(new Uint8Array(), { fileSize: 4, readError: new Error('read failed') })
    await expect(
      pickMobileImage('files', {
        launchFiles: vi.fn().mockResolvedValue({
          canceled: false,
          assets: [{ uri: 'file:///broken.png', size: 4 }]
        }),
        createFile: file.createFile
      })
    ).rejects.toThrow('read failed')
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('routes large or high-resolution images through on-device preparation', async () => {
    expect(shouldDownsampleMobileImage({ fileSize: 5 * 1024 * 1024 })).toBe(true)
    expect(shouldDownsampleMobileImage({ width: 3000, height: 1200 })).toBe(true)
    expect(shouldDownsampleMobileImage({ fileSize: 100, width: 800, height: 600 })).toBe(false)

    const prepareImage = vi.fn().mockResolvedValue({
      base64: 'AAAA',
      uri: 'file:///resized.png'
    })
    const result = await pickMobileImage('library', {
      requestLibraryPermission: vi.fn().mockResolvedValue(granted),
      launchLibrary: vi.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///large.jpg', fileSize: 5 * 1024 * 1024, width: 4000, height: 3000 }]
      }),
      prepareImage
    })

    expect(result).toEqual({ base64: 'AAAA', uri: 'file:///resized.png' })
    expect(prepareImage).toHaveBeenCalledWith({
      uri: 'file:///large.jpg',
      fileSize: 5 * 1024 * 1024,
      width: 4000,
      height: 3000
    })
  })

  it('never guesses a resize that can upscale an image with unknown dimensions', async () => {
    const resize = vi.fn()
    const release = vi.fn()
    vi.mocked(ImageManipulator.manipulate).mockReturnValue({
      resize,
      renderAsync: vi.fn().mockResolvedValue({
        saveAsync: vi.fn().mockResolvedValue({ base64: 'AAAA', uri: 'file:///compressed.png' }),
        release
      }),
      release
    } as never)

    await prepareMobileImageForUpload({
      uri: 'file:///unknown.png',
      fileSize: 5 * 1024 * 1024
    })

    expect(resize).not.toHaveBeenCalled()
  })

  it('keeps the final quality-rung preview file while deleting superseded rungs', async () => {
    const oversized = 'A'.repeat(MOBILE_IMAGE_DOWNSAMPLE_TARGET_BASE64 + 1)
    let attempt = 0
    vi.mocked(ImageManipulator.manipulate).mockImplementation(() => {
      const uri = `file:///quality-${++attempt}.png`
      const release = vi.fn()
      return {
        resize: vi.fn(),
        renderAsync: vi.fn().mockResolvedValue({
          saveAsync: vi.fn().mockResolvedValue({ base64: oversized, uri }),
          release
        }),
        release
      } as never
    })
    const deleted: string[] = []

    const result = await prepareMobileImageForUpload(
      {
        uri: 'file:///large.png',
        fileSize: 5 * 1024 * 1024,
        width: 4000,
        height: 3000
      },
      (uri) => deleted.push(uri)
    )

    expect(result?.uri).toBe('file:///quality-3.png')
    expect(deleted).toEqual(['file:///quality-1.png', 'file:///quality-2.png'])
  })
})
