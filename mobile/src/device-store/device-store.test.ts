import { randomBytes } from 'node:crypto'
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
import { deriveHostCacheKey } from '../mobile-web-shell/host-cache-key'
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
  it('evicts least-recently-used cache rows past the cap across a relaunch and never touches drafts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fileSystem = createFakeGenerationFileSystem()
    const keychain = memoryKeychain()
    const firstLaunch = storeOn(fileSystem, { keychain })
    await firstLaunch.runLaunchMaintenance()
    for (let draft = 0; draft < 3; draft += 1) {
      await firstLaunch.write('host-a', 'draft', [
        { key: `draft-${draft}`, value: base64('typed') }
      ])
    }
    // 512 KiB encoded seals to 393,244 bytes, so the 342nd row crosses 128 MiB and eviction keeps 307.
    const value = randomBytes(393_216).toString('base64')
    const writeRow = async (target: typeof firstLaunch, row: number) => {
      vi.setSystemTime(1_000_000 + row)
      expect(await target.write('host-a', 'cache', [{ key: `row-${row}`, value }])).toEqual({
        written: true
      })
    }
    for (let row = 0; row < 300; row += 1) {
      await writeRow(firstLaunch, row)
    }
    // The next launch learns the first 300 rows only from its seed.
    const store = storeOn(fileSystem, { keychain })
    await store.runLaunchMaintenance()
    for (let row = 300; row < 350; row += 1) {
      await writeRow(store, row)
    }
    vi.useRealTimers()
    const cache = await store.read('host-a', 'cache', ['row-0', 'row-34', 'row-35', 'row-349'])
    expect(cache.status === 'ok' && cache.values.map((v) => v !== null)).toEqual([
      false,
      false,
      true,
      true
    ])
    expect(await store.read('host-a', 'draft', ['draft-0', 'draft-1', 'draft-2'])).toEqual({
      status: 'ok',
      values: [base64('typed'), base64('typed'), base64('typed')]
    })
  })

  it('leaves no file of a removed host, whether wiped directly or swept at the next launch', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const keychain = memoryKeychain()
    const store = storeOn(fileSystem, { keychain })
    for (const hostId of ['host-a', 'host-b', 'host-c']) {
      await store.write(hostId, 'cache', [{ key: 'hosts', value: base64(hostId) }])
      await store.write(hostId, 'draft', [{ key: 'draft', value: base64(hostId) }])
    }
    await store.wipeHost('host-a')
    const hostPaths = (hostId: string) =>
      fileSystem.paths().filter((path) => path.includes(deriveHostCacheKey(hostId)))
    expect(hostPaths('host-a')).toEqual([])

    // Relaunch with host-c missing from the stored host list.
    const relaunched = storeOn(fileSystem, { keychain })
    await relaunched.runLaunchMaintenance()
    expect(hostPaths('host-c')).toEqual([])
    expect(await relaunched.read('host-b', 'draft', ['draft'])).toEqual({
      status: 'ok',
      values: [base64('host-b')]
    })
  })

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
