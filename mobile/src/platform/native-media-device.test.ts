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
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-image-picker', () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
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
    writeSync(content: string | Uint8Array): void {
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

import { copyPickedMediaIntoCache } from './native-media-device'

describe('copying a provider uri into the cache', () => {
  it('deletes the file it created when the source could not be read', () => {
    // Clean failed writes here because callers never learn the new file’s name.
    const before = expo.deleted.length
    expect(() => copyPickedMediaIntoCache('content://media/gone')).toThrow(/nothing readable/)
    expect(expo.deleted.length).toBe(before + 1)
    expect(expo.deleted.at(-1)?.startsWith('file:///cache/orca-media-')).toBe(true)
  })
})
