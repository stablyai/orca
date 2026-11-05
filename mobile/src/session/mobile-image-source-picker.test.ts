import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-image-picker', () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn()
}))
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn()
}))
vi.mock('expo-file-system', () => ({
  File: vi.fn()
}))

import {
  pickMobileImage,
  pickMobileImages,
  type PickedMobileImage
} from './mobile-image-source-picker'

const granted = { granted: true } as Awaited<
  ReturnType<typeof import('expo-image-picker').requestMediaLibraryPermissionsAsync>
>

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

    expect(result).toEqual([
      { uri: 'file:///a.jpg', base64: 'AQ==' },
      { uri: 'file:///b.jpg', base64: 'Ag==' },
      { uri: 'file:///c.jpg', base64: 'Aw==' }
    ])
    expect(launchLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: 0
      })
    )
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
})
