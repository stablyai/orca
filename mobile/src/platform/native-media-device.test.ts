/** The device calls themselves: the options that make a picked file one this shell owns. */
import { describe, expect, it, vi } from 'vitest'

const expo = vi.hoisted(() => ({
  launchImageLibraryAsync: vi.fn((_options: Record<string, unknown>) =>
    Promise.resolve({ canceled: true })
  ),
  requestMediaLibraryPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  getDocumentAsync: vi.fn(() => Promise.resolve({ canceled: true })),
  getImageAsync: vi.fn(() => Promise.resolve(null)),
  deleted: new Array<string>(),
  written: new Array<{ uri: string; base64: string }>(),
  copiedBytes: new Array<{ uri: string; bytes: number[] }>(),
  sources: new Map<string, Uint8Array>()
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
    write(content: string | Uint8Array): void {
      expo.written.push({ uri: this.uri, base64: typeof content === 'string' ? content : '' })
      if (typeof content !== 'string') {
        expo.copiedBytes.push({ uri: this.uri, bytes: [...content] })
      }
    }
    bytesSync(): Uint8Array {
      const bytes = expo.sources.get(this.uri)
      if (bytes === undefined) {
        throw new Error(`nothing readable at ${this.uri}`)
      }
      return bytes
    }
    delete(): void {
      expo.deleted.push(this.uri)
    }
  },
  Paths: { cache: 'file:///cache' }
}))

import { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import {
  copyPickedMediaIntoCache,
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
    await deps().launchLibrary({ multiple: false, limit: 8 })
    expect(expo.launchImageLibraryAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        base64: false,
        allowsMultipleSelection: false
      })
    )
    // No selection limit on a single pick: the OS returns one asset and `0` would mean unlimited.
    expect(expo.launchImageLibraryAsync.mock.lastCall?.[0]).not.toHaveProperty('selectionLimit')
  })

  it('bounds a multi-select to the room it was given, never to unlimited', async () => {
    // `selectionLimit: 0` is unlimited to the OS picker, which is the shape that lets a user wait
    // through a nine-photo copy to be refused by the registry afterwards.
    for (const limit of [8, 3, 1]) {
      await deps().launchLibrary({ multiple: true, limit })
      expect(expo.launchImageLibraryAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: limit })
      )
    }
  })

  it('asks the document picker to copy into the cache, which is what makes the uri ownable', async () => {
    // Without this the picker hands back the provider's own uri on Android and the handle it
    // backs can never be released.
    await deps().launchFiles({ multiple: true, limit: 8 })
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

describe('copying a provider uri into the cache', () => {
  it('reads the source through the unified file and writes a copy this shell owns', () => {
    const source = 'content://media/external/images/media/42'
    expo.sources.set(source, Uint8Array.from([1, 2, 3, 4]))
    const uri = copyPickedMediaIntoCache(source)
    expect(ownsStagedMediaUri(uri)).toBe(true)
    expect(uri.startsWith('file:///cache/orca-media-')).toBe(true)
    expect(expo.copiedBytes.at(-1)).toEqual({ uri, bytes: [1, 2, 3, 4] })
  })

  it('deletes the file it created when the source could not be read', () => {
    // The caller never learns this name, so an empty file left here is nobody's to sweep.
    const before = expo.deleted.length
    expect(() => copyPickedMediaIntoCache('content://media/gone')).toThrow(/nothing readable/)
    expect(expo.deleted.length).toBe(before + 1)
    expect(expo.deleted.at(-1)?.startsWith('file:///cache/orca-media-')).toBe(true)
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
