import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn()
}))
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn()
}))

import { ImageLibraryPermissionError, pickMobileImage } from './mobile-image-source-picker'

const granted = { granted: true } as Awaited<
  ReturnType<typeof import('expo-image-picker').requestMediaLibraryPermissionsAsync>
>
const denied = { granted: false } as typeof granted

describe('pickMobileImage', () => {
  it('returns base64 from the photo library', async () => {
    const result = await pickMobileImage('library', {
      requestLibraryPermission: vi.fn().mockResolvedValue(granted),
      launchLibrary: vi.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///x.jpg', base64: 'AAAA' }]
      })
    })

    expect(result).toEqual({ base64: 'AAAA', uri: 'file:///x.jpg' })
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
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(bytes.buffer, { headers: { 'content-type': 'image/png' } }))

    const result = await pickMobileImage('files', {
      launchFiles: vi.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///doc.png' }]
      })
    })

    expect(result).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      uri: 'file:///doc.png'
    })
    fetchSpy.mockRestore()
  })

  it('returns null when the files picker is cancelled', async () => {
    const result = await pickMobileImage('files', {
      launchFiles: vi.fn().mockResolvedValue({ canceled: true, assets: null })
    })

    expect(result).toBeNull()
  })
})
