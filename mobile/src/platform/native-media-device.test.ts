/** The device calls themselves: the options that make a picked file one this shell owns. */
import { describe, expect, it, vi } from 'vitest'

const expo = vi.hoisted(() => ({
  launchImageLibraryAsync: vi.fn(() => Promise.resolve({ canceled: true })),
  requestMediaLibraryPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  getDocumentAsync: vi.fn(() => Promise.resolve({ canceled: true })),
  getImageAsync: vi.fn(() => Promise.resolve(null)),
  deleted: [] as string[],
  written: [] as { uri: string; base64: string }[]
}))

vi.mock('expo-clipboard', () => ({ getImageAsync: expo.getImageAsync }))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: expo.getDocumentAsync }))
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: expo.launchImageLibraryAsync,
  requestMediaLibraryPermissionsAsync: expo.requestMediaLibraryPermissionsAsync
}))
vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string
    readonly size = 7
    constructor(...parts: string[]) {
      this.uri = parts.join('/')
    }
    create(): void {}
    write(base64: string): void {
      expo.written.push({ uri: this.uri, base64 })
    }
    delete(): void {
      expo.deleted.push(this.uri)
    }
  },
  Paths: { cache: 'file:///cache' }
}))

import { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import {
  discardStagedMedia,
  nativeMediaDeviceDeps,
  ownsStagedMediaUri
} from './native-media-device'

const deps = (): ReturnType<typeof nativeMediaDeviceDeps> =>
  nativeMediaDeviceDeps(new MediaHandleRegistry({ now: () => 0, discard: () => {} }))

describe('which uris this shell owns', () => {
  it('takes the cache copy both pickers produce and refuses an Android provider uri', () => {
    expect(ownsStagedMediaUri('file:///cache/orca-media-1.png')).toBe(true)
    for (const uri of [
      'content://media/external/images/media/42',
      'ph://ABC-123',
      'https://example.com/a.png',
      ''
    ]) {
      expect(ownsStagedMediaUri(uri), uri).toBe(false)
    }
  })
})

describe('how the pickers are launched', () => {
  it('asks the library for images the shell can own, single and multiple', async () => {
    await deps().launchLibrary({ multiple: false })
    expect(expo.launchImageLibraryAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        base64: false,
        allowsMultipleSelection: false
      })
    )
    await deps().launchLibrary({ multiple: true })
    expect(expo.launchImageLibraryAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 0 })
    )
  })

  it('asks the document picker to copy into the cache, which is what makes the uri ownable', async () => {
    // Without this the picker hands back the provider's own uri on Android and the handle it
    // backs can never be released.
    await deps().launchFiles({ multiple: true })
    expect(expo.getDocumentAsync).toHaveBeenLastCalledWith({
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: true
    })
  })

  it('reads the pasteboard as png, because that is what it re-encodes to', async () => {
    await deps().readClipboardImage()
    expect(expo.getImageAsync).toHaveBeenLastCalledWith({ format: 'png' })
  })
})

describe('staging and discarding', () => {
  it('writes pasteboard base64 into a cache file of this shell s own, and answers its uri', () => {
    const uri = deps().stageBase64('AAAA')
    expect(uri.startsWith('file:///cache/orca-media-')).toBe(true)
    expect(ownsStagedMediaUri(uri)).toBe(true)
    expect(expo.written.at(-1)).toEqual({ uri, base64: 'AAAA' })
  })

  it('deletes one staged file by uri', () => {
    discardStagedMedia('file:///cache/orca-media-9.png')
    expect(expo.deleted).toContain('file:///cache/orca-media-9.png')
  })
})
