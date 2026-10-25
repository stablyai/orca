import { describe, expect, it, vi } from 'vitest'

const expo = vi.hoisted(() => ({
  launchImageLibraryAsync: vi.fn((_options: Record<string, unknown>) =>
    Promise.resolve({ canceled: true })
  ),
  requestMediaLibraryPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  getDocumentAsync: vi.fn(() => Promise.resolve({ canceled: true })),
  getImageAsync: vi.fn(() => Promise.resolve(null)),
  deleted: new Array<string>(),
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
import { createNativeMediaVerbServer } from './native-media'
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

describe('the library permission this shell does not ask for', () => {
  it('never calls requestMediaLibraryPermissionsAsync for a library pick', async () => {
    // Exercise the full verb: Expo’s OS library picker needs no prior permission request on either platform, and an extra denial would reject a valid pick.
    const serve = createNativeMediaVerbServer(
      nativeMediaDeviceDeps(new MediaHandleRegistry({ now: () => 0, discard: () => {} }))
    )
    await expect(
      serve('native.media.pick', { source: 'library', multiple: false })
    ).resolves.toEqual({ items: [] })
    expect(expo.launchImageLibraryAsync).toHaveBeenCalled()
    expect(expo.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled()
  })
})

describe('how the pickers are launched', () => {
  it('asks the library for an image the shell can own in a single pick', async () => {
    await deps().launchLibrary({ multiple: false, limit: 8 })
    expect(expo.launchImageLibraryAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        base64: false,
        allowsMultipleSelection: false
      })
    )
    // Omit selectionLimit for single picks; zero means unlimited.
    expect(expo.launchImageLibraryAsync.mock.lastCall?.[0]).not.toHaveProperty('selectionLimit')
  })

  it('bounds a multi-select to the room it was given, never to unlimited', async () => {
    // A zero limit copies an unlimited selection before the registry can refuse it.
    for (const limit of [8, 3, 1]) {
      await deps().launchLibrary({ multiple: true, limit })
      expect(expo.launchImageLibraryAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: limit })
      )
    }
  })

  it('asks the document picker to copy into the cache, which is what makes the uri ownable', async () => {
    // Copy Android provider URIs into owned cache files so their handles can be released.
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
    // Clean failed writes here because callers never learn the new file’s name.
    const before = expo.deleted.length
    expect(() => copyPickedMediaIntoCache('content://media/gone')).toThrow(/nothing readable/)
    expect(expo.deleted.length).toBe(before + 1)
    expect(expo.deleted.at(-1)?.startsWith('file:///cache/orca-media-')).toBe(true)
  })
})

describe('staging and discarding', () => {
  it('deletes one staged file by uri', () => {
    discardStagedMedia('file:///cache/orca-media-9.png')
    expect(expo.deleted).toContain('file:///cache/orca-media-9.png')
  })
})
