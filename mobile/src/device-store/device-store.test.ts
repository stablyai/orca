import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {} }))
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }))
vi.mock('../transport/host-metadata-store', () => ({ loadStoredHostProfiles: async () => [] }))
vi.mock('../transport/pairing-keychain', () => ({
  readPairingKeychainItem: async () => null,
  writePairingKeychainItem: async () => undefined
}))

import {
  createFakeGenerationFileSystem,
  FAKE_GENERATION_ROOT,
  type FakeGenerationFileSystem
} from '../mobile-web-shell/generation-file-system-fake'
import { createDeviceStore, type DeviceStoreOptions } from './device-store'
import { deviceStoreRows } from './device-store-files'
import type { DeviceStoreKeychain } from './device-store-key'

const ROOTS = {
  cache: `${FAKE_GENERATION_ROOT}/orca-store/v1`,
  draft: `${FAKE_GENERATION_ROOT}/orca-drafts/v1`
}

function memoryKeychain(): DeviceStoreKeychain & { stored: string | null } {
  const keychain: DeviceStoreKeychain & { stored: string | null } = {
    stored: null,
    read: async () => keychain.stored,
    write: async (hexKey: string) => {
      keychain.stored = hexKey
    }
  }
  return keychain
}

function storeOn(
  fileSystem: FakeGenerationFileSystem,
  overrides: Partial<DeviceStoreOptions> = {}
) {
  return createDeviceStore({
    fileSystem,
    roots: ROOTS,
    keychain: memoryKeychain(),
    loadPairedHostIds: async () => ['host-a', 'host-b'],
    ...overrides
  })
}

const base64 = (text: string): string => Buffer.from(text).toString('base64')
const relative = (uri: string): string => uri.slice(FAKE_GENERATION_ROOT.length + 1)
const rowUri = (hostId: string, table: 'cache' | 'draft', key: string): string =>
  deviceStoreRows(ROOTS, hostId, table, [key])[0]!.uri

describe('device store', () => {
  it('wipes and remints when the key is gone but files remain', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await storeOn(fileSystem).write('host-a', 'draft', [{ key: 'draft', value: base64('x') }])
    expect(fileSystem.paths().some((path) => path.startsWith('orca-drafts/v1/'))).toBe(true)

    const keychain = memoryKeychain()
    const relaunched = storeOn(fileSystem, { keychain })
    expect(await relaunched.open()).toBe('ready')
    expect(fileSystem.paths().filter((path) => fileSystem.bytes(path) !== null)).toEqual([])
    expect(keychain.stored).toMatch(/^[0-9a-f]{64}$/)
  })

  it('deletes nothing when the key read throws, and stays unavailable until reopened', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const keychain = memoryKeychain()
    await storeOn(fileSystem, { keychain }).write('host-a', 'draft', [
      { key: 'draft', value: base64('x') }
    ])
    const before = fileSystem.paths()

    const locked = storeOn(fileSystem, {
      keychain: {
        read: async () => {
          throw new Error('locked')
        },
        write: keychain.write
      }
    })
    expect(await locked.open()).toBe('unavailable')
    expect(await locked.read('host-a', 'draft', ['draft'])).toEqual({ status: 'unavailable' })
    expect(await locked.write('host-a', 'draft', [{ key: 'draft', value: null }])).toEqual({
      written: false,
      refusal: 'unavailable'
    })
    expect(fileSystem.paths()).toEqual(before)
  })

  it('refuses to open a sealed file copied to another value’s path', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = storeOn(fileSystem)
    await store.write('host-a', 'cache', [
      { key: 'a', value: base64('secret a') },
      { key: 'b', value: base64('secret b') }
    ])
    const fromA = relative(rowUri('host-a', 'cache', 'a'))
    const toB = relative(rowUri('host-a', 'cache', 'b'))
    fileSystem.seed(toB, { kind: 'file', bytes: fileSystem.bytes(fromA)! })
    expect(await store.read('host-a', 'cache', ['a', 'b'])).toEqual({
      status: 'ok',
      values: [base64('secret a'), null]
    })
  })

  it('reads a draft write interrupted before the move as the new value', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = storeOn(fileSystem)
    const target = relative(rowUri('host-a', 'draft', 'draft'))
    await store.write('host-a', 'draft', [{ key: 'draft', value: base64('new text') }])
    const newBytes = fileSystem.bytes(target)!

    // Crash after the .tmp write, with the old file still in place.
    await store.write('host-a', 'draft', [{ key: 'draft', value: base64('old text') }])
    fileSystem.seed(`${target}.tmp`, { kind: 'file', bytes: newBytes })
    expect(await store.read('host-a', 'draft', ['draft'])).toEqual({
      status: 'ok',
      values: [base64('new text')]
    })

    // Crash after the old file was deleted.
    await store.write('host-a', 'draft', [{ key: 'draft', value: base64('old text') }])
    await fileSystem.delete(rowUri('host-a', 'draft', 'draft'))
    fileSystem.seed(`${target}.tmp`, { kind: 'file', bytes: newBytes })
    expect(await store.read('host-a', 'draft', ['draft'])).toEqual({
      status: 'ok',
      values: [base64('new text')]
    })
  })
})
