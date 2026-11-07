import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {} }))
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }))
vi.mock('../transport/host-metadata-store', () => ({ loadStoredHostProfiles: async () => [] }))
vi.mock('../transport/pairing-keychain', () => ({
  readPairingKeychainItem: async () => null,
  writePairingKeychainItem: async () => undefined
}))

import { createDeviceStore } from '../device-store/device-store'
import { createFakeGenerationFileSystem, FAKE_GENERATION_ROOT } from './generation-file-system-fake'
import { serveDeviceStoreVerb } from './device-store-verb-server'

function store() {
  let hexKey: string | null = null
  return createDeviceStore({
    fileSystem: createFakeGenerationFileSystem(),
    roots: {
      cache: `${FAKE_GENERATION_ROOT}/orca-store/v1`,
      draft: `${FAKE_GENERATION_ROOT}/orca-drafts/v1`
    },
    keychain: {
      read: async () => hexKey,
      write: async (next) => {
        hexKey = next
      }
    },
    loadPairedHostIds: async () => ['host-a', 'host-b']
  })
}

const base64 = (text: string): string => Buffer.from(text).toString('base64')

describe('the native.store.rows verb', () => {
  it('keeps a page on its own host even when its keys name another host’s worktree', async () => {
    const device = store()
    const key = 'draft:chat:host-b-worktree:tab-1'
    await serveDeviceStoreVerb(device, 'host-b', {
      action: 'write',
      table: 'draft',
      ops: [{ key, value: base64('typed on host B') }]
    })

    expect(
      await serveDeviceStoreVerb(device, 'host-a', { action: 'read', table: 'draft', keys: [key] })
    ).toEqual({ values: [null], deferred: [] })
    await serveDeviceStoreVerb(device, 'host-a', {
      action: 'write',
      table: 'draft',
      ops: [{ key, value: null }]
    })
    expect(
      await serveDeviceStoreVerb(device, 'host-b', { action: 'read', table: 'draft', keys: [key] })
    ).toEqual({ values: [base64('typed on host B')], deferred: [] })
    // The page cannot name a host at all.
    await expect(
      serveDeviceStoreVerb(device, 'host-a', {
        action: 'read',
        table: 'draft',
        keys: [key],
        hostId: 'host-b'
      })
    ).rejects.toThrow()
  })

  it('defers values past the 6 MiB reply budget instead of failing the read', async () => {
    const device = store()
    // 512 KiB encoded each: twelve fill 6 MiB, the thirteenth waits for the next read.
    const values = Array.from({ length: 13 }, () => randomBytes(393_216).toString('base64'))
    const keys = values.map((_value, at) => `q-${String(at)}`)
    for (const [at, value] of values.entries()) {
      await serveDeviceStoreVerb(device, 'host-a', {
        action: 'write',
        table: 'cache',
        ops: [{ key: keys[at], value }]
      })
    }

    const reply = await serveDeviceStoreVerb(device, 'host-a', {
      action: 'read',
      table: 'cache',
      keys
    })

    expect(reply).toEqual({ values: [...values.slice(0, 12), null], deferred: [12] })
  })
})
