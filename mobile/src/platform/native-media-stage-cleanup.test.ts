import { beforeEach, afterEach, expect, it, vi } from 'vitest'

type FileEvent = {
  operation: 'create' | 'write' | 'delete'
  uri: string
  content?: string | Uint8Array
  options?: { overwrite?: boolean; encoding?: string }
}

type StorageState = {
  files: Map<string, Uint8Array>
  events: FileEvent[]
  writeFailure: unknown
  deleteFailure: unknown
  createFailure: unknown
  readFailure: unknown
  partialBytes: number
}

const storage = vi.hoisted<StorageState>(() => ({
  files: new Map(),
  events: [],
  writeFailure: null,
  deleteFailure: null,
  createFailure: null,
  readFailure: null,
  partialBytes: 0
}))

vi.mock('expo-clipboard', () => ({
  getImageAsync: () => Promise.resolve({ data: 'data:image/png;base64,AQID' })
}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string

    constructor(...parts: string[]) {
      this.uri = parts.join('/')
    }

    get size(): number {
      return storage.files.get(this.uri)?.byteLength ?? 0
    }

    create(options: { overwrite?: boolean }): void {
      storage.events.push({ operation: 'create', uri: this.uri, options })
      storage.files.set(this.uri, new Uint8Array())
      if (storage.createFailure !== null) {
        throw storage.createFailure
      }
    }

    write(content: string | Uint8Array, options?: { encoding?: string }): void {
      storage.events.push({ operation: 'write', uri: this.uri, content, options })
      if (storage.writeFailure !== null) {
        storage.files.set(this.uri, new Uint8Array(storage.partialBytes))
        throw storage.writeFailure
      }
      storage.files.set(
        this.uri,
        typeof content === 'string' ? Uint8Array.from(Buffer.from(content, 'base64')) : content
      )
    }

    bytesSync(): Uint8Array {
      if (storage.readFailure !== null) {
        throw storage.readFailure
      }
      return Uint8Array.from([9, 8])
    }

    delete(): void {
      storage.events.push({ operation: 'delete', uri: this.uri })
      if (storage.deleteFailure !== null) {
        throw storage.deleteFailure
      }
      storage.files.delete(this.uri)
    }
  },
  Paths: { cache: 'file:///cache' }
}))

import { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import { createNativeMediaVerbServer } from './native-media'
import { copyPickedMediaIntoCache, nativeMediaDeviceDeps } from './native-media-device'

beforeEach(() => {
  storage.files.clear()
  storage.events.length = 0
  storage.writeFailure = null
  storage.deleteFailure = null
  storage.createFailure = null
  storage.readFailure = null
  storage.partialBytes = 0
  vi.spyOn(Date, 'now').mockReturnValue(1234)
  vi.spyOn(Math, 'random').mockReturnValue(0.25)
})

afterEach(() => vi.restoreAllMocks())

function device() {
  return nativeMediaDeviceDeps(new MediaHandleRegistry({ now: () => 0, discard: vi.fn() }))
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected staging to throw')
}

function heldBytes(): number {
  return [...storage.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
}

it('preserves the successful staged URI, base64 options and bytes without deleting it', () => {
  const uri = device().stageBase64('AQID')
  expect(uri).toBe('file:///cache/orca-media-1234-0.25.png')
  expect(storage.events).toEqual([
    { operation: 'create', uri, options: { overwrite: true } },
    { operation: 'write', uri, content: 'AQID', options: { encoding: 'base64' } }
  ])
  expect(storage.files.get(uri)).toEqual(Uint8Array.from([1, 2, 3]))
})

it.each([0, 4096])('releases an unreturned file after a write fails with %i bytes', (bytes) => {
  const original = new Error('partial native write')
  storage.writeFailure = original
  storage.partialBytes = bytes
  expect(thrownBy(() => device().stageBase64('AQID'))).toBe(original)
  expect(heldBytes()).toBe(0)
  expect(storage.files.size).toBe(0)
  expect(storage.events.at(-1)).toEqual({
    operation: 'delete',
    uri: 'file:///cache/orca-media-1234-0.25.png'
  })
})

it('preserves the write failure when best-effort deletion also fails', () => {
  const original = new Error('native write failed')
  storage.writeFailure = original
  storage.deleteFailure = new Error('cache cannot be deleted')
  storage.partialBytes = 4096
  expect(thrownBy(() => device().stageBase64('AQID'))).toBe(original)
  expect(storage.events.map((event) => event.operation)).toEqual(['create', 'write', 'delete'])
  expect(heldBytes()).toBe(4096)
})

it('preserves creation failure and its original operation order', () => {
  const original = new Error('native create failed')
  storage.createFailure = original
  expect(thrownBy(() => device().stageBase64('AQID'))).toBe(original)
  expect(storage.events.map((event) => event.operation)).toEqual(['create'])
})

it('deletes only the failed file while a prior successful file remains readable', () => {
  vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.2)
  const successfulUri = device().stageBase64('AQID')
  const original = new Error('next write failed')
  storage.writeFailure = original
  storage.partialBytes = 4096
  expect(thrownBy(() => device().stageBase64('BAUG'))).toBe(original)
  expect(storage.events.filter((event) => event.operation === 'delete')).toEqual([
    { operation: 'delete', uri: 'file:///cache/orca-media-1234-0.2.png' }
  ])
  expect([...storage.files.keys()]).toEqual([successfulUri])
  expect(storage.files.get(successfulUri)).toEqual(Uint8Array.from([1, 2, 3]))
  expect(heldBytes()).toBe(3)
})

it('keeps the clipboard verb rejection while leaving no unregistered cache bytes', async () => {
  const original = new Error('clipboard write failed')
  storage.writeFailure = original
  storage.partialBytes = 4096
  const registryDiscard = vi.fn()
  const registry = new MediaHandleRegistry({ now: () => 0, discard: registryDiscard })
  const serve = createNativeMediaVerbServer(nativeMediaDeviceDeps(registry))
  await expect(serve('native.media.pick', { source: 'clipboard', multiple: false })).rejects.toBe(
    original
  )
  expect(registry.liveCount()).toBe(0)
  expect(registryDiscard).not.toHaveBeenCalled()
  expect(heldBytes()).toBe(0)
  expect(storage.files.size).toBe(0)
})

it('retains the provider-copy cleanup and original read error when deletion fails', () => {
  const original = new Error('provider read failed')
  storage.readFailure = original
  storage.deleteFailure = new Error('cache delete failed')
  expect(thrownBy(() => copyPickedMediaIntoCache('content://media/1'))).toBe(original)
  expect(storage.events).toEqual([
    {
      operation: 'create',
      uri: 'file:///cache/orca-media-1234-0.25.bin',
      options: { overwrite: true }
    },
    { operation: 'delete', uri: 'file:///cache/orca-media-1234-0.25.bin' }
  ])
})
