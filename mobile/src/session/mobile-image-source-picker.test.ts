import { afterEach, describe, expect, it, vi } from 'vitest'
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

import { ImageLibraryPermissionError, pickMobileImage } from './mobile-image-source-picker'

const granted = { granted: true } as Awaited<
  ReturnType<typeof import('expo-image-picker').requestMediaLibraryPermissionsAsync>
>
const denied = { granted: false } as typeof granted

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

  it('rejects an oversized asset before opening it', async () => {
    const file = fileFactory(new Uint8Array([1]))
    await expect(
      pickMobileImage('files', {
        launchFiles: vi.fn().mockResolvedValue({
          canceled: false,
          assets: [{ uri: 'file:///huge.png', size: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1 }]
        }),
        createFile: file.createFile
      })
    ).rejects.toThrow('Clipboard image is too large')
    expect(file.createFile).not.toHaveBeenCalled()
    expect(file.open).not.toHaveBeenCalled()
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
