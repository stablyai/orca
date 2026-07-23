import { describe, expect, it, vi } from 'vitest'
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
  chunks: Uint8Array[],
  options?: { fileSize?: number; handleSize?: number | null; readError?: Error }
) {
  const close = vi.fn()
  const readBytes = vi.fn(() => {
    if (options?.readError) {
      throw options.readError
    }
    return chunks.shift() ?? new Uint8Array()
  })
  const open = vi.fn(() => ({
    size: options?.handleSize ?? options?.fileSize ?? 0,
    readBytes,
    close
  }))
  const createFile = vi.fn(() => ({ size: options?.fileSize ?? 0, open }))
  return { close, createFile, open, readBytes }
}

describe('pickMobileImage', () => {
  it('returns base64 from the photo library', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3])
    const file = fileFactory([bytes])
    const launchLibrary = vi.fn().mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///x.jpg', fileSize: bytes.length }]
    })
    const result = await pickMobileImage('library', {
      requestLibraryPermission: vi.fn().mockResolvedValue(granted),
      launchLibrary,
      createFile: file.createFile
    })

    expect(result).toEqual({ base64: Buffer.from(bytes).toString('base64') })
    expect(launchLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ base64: false, allowsMultipleSelection: false })
    )
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
    const file = fileFactory([bytes])
    const launchFiles = vi.fn().mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///doc.png', size: bytes.length }]
    })

    const result = await pickMobileImage('files', {
      launchFiles,
      createFile: file.createFile
    })

    expect(result).toEqual({ base64: Buffer.from(bytes).toString('base64') })
    expect(launchFiles).toHaveBeenCalledWith(
      expect.objectContaining({ copyToCacheDirectory: true })
    )
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('returns null when the files picker is cancelled', async () => {
    const result = await pickMobileImage('files', {
      launchFiles: vi.fn().mockResolvedValue({ canceled: true, assets: null })
    })

    expect(result).toBeNull()
  })

  it('rejects a declared oversized asset before opening it', async () => {
    const file = fileFactory([], { fileSize: 1 })
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

  it('does not let stale size metadata bypass the bounded read', async () => {
    const close = vi.fn()
    const readBytes = vi.fn((length: number) => new Uint8Array(length))
    const createFile = vi.fn(() => ({
      size: 1,
      open: () => ({ size: 1, readBytes, close })
    }))

    await expect(
      pickMobileImage('library', {
        requestLibraryPermission: vi.fn().mockResolvedValue(granted),
        launchLibrary: vi.fn().mockResolvedValue({
          canceled: false,
          assets: [{ uri: 'file:///grew.png', fileSize: 1 }]
        }),
        createFile
      })
    ).rejects.toThrow('Clipboard image is too large')
    expect(readBytes).toHaveBeenLastCalledWith(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the file handle when a read fails', async () => {
    const file = fileFactory([], { fileSize: 4, readError: new Error('read failed') })
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

  it('preserves bytes across chunk boundaries that are not base64 aligned', async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4, 5])]
    const file = fileFactory([...chunks], { fileSize: 5, handleSize: 5 })
    const result = await pickMobileImage('files', {
      launchFiles: vi.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///chunked.png', size: 5 }]
      }),
      createFile: file.createFile
    })
    expect(result).toEqual({ base64: Buffer.from([1, 2, 3, 4, 5]).toString('base64') })
    expect(file.close).toHaveBeenCalledTimes(1)
  })
})
