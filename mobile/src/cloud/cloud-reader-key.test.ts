import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, options } = vi.hoisted(() => {
  const options: unknown[] = []
  return { store: new Map<string, string>(), options }
})
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async (key: string, opts: unknown) => {
    options.push(opts)
    return store.get(key) ?? null
  }),
  setItemAsync: vi.fn(async (key: string, value: string, opts: unknown) => {
    options.push(opts)
    store.set(key, value)
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key)
  })
}))

import nacl from 'tweetnacl'
import {
  clearCloudReaderKey,
  loadCloudReaderKey,
  saveCloudReaderKeyRegistration
} from './cloud-reader-key'

const STORE_KEY = 'orca.cloud-reader.v1'

beforeEach(() => {
  store.clear()
  options.length = 0
})

describe('cloud reader key store', () => {
  it('generates one X25519 key lazily, this device only, and keeps it', async () => {
    const [a, b] = await Promise.all([loadCloudReaderKey('ds_1'), loadCloudReaderKey('ds_1')])
    expect(a.publicKeyB64).toBe(b.publicKeyB64)
    expect(a.secretKey).toHaveLength(32)
    expect(a.registration).toBeNull()
    expect(Buffer.from(nacl.scalarMult.base(a.secretKey)).toString('base64')).toBe(a.publicKeyB64)
    expect(options).toContainEqual({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' })
    expect(options.every((o) => JSON.stringify(o).includes('WHEN_UNLOCKED_THIS_DEVICE_ONLY'))).toBe(
      true
    )
    expect((await loadCloudReaderKey('ds_1')).publicKeyB64).toBe(a.publicKeyB64)
  })

  it('records the registration for the same key only', async () => {
    const key = await loadCloudReaderKey('ds_1')
    await saveCloudReaderKeyRegistration(key, { keyId: 'rk_1', registeredAt: 5 })
    expect((await loadCloudReaderKey('ds_1')).registration).toEqual({
      keyId: 'rk_1',
      registeredAt: 5
    })
    await saveCloudReaderKeyRegistration(
      { deviceSessionId: 'ds_1', publicKeyB64: 'other' },
      { keyId: 'rk_2', registeredAt: 6 }
    )
    expect((await loadCloudReaderKey('ds_1')).registration?.keyId).toBe('rk_1')
  })

  it('mints a new key for a new device session', async () => {
    const first = await loadCloudReaderKey('ds_1')
    await saveCloudReaderKeyRegistration(first, { keyId: 'rk_1', registeredAt: 5 })
    const second = await loadCloudReaderKey('ds_2')
    expect(second.publicKeyB64).not.toBe(first.publicKeyB64)
    expect(second.registration).toBeNull()
  })

  it('replaces an unreadable item and drops the key on clear', async () => {
    store.set(STORE_KEY, '{not json')
    const key = await loadCloudReaderKey('ds_1')
    expect(key.secretKey).toHaveLength(32)
    await clearCloudReaderKey()
    expect(store.has(STORE_KEY)).toBe(false)
    expect((await loadCloudReaderKey('ds_1')).publicKeyB64).not.toBe(key.publicKeyB64)
  })
})
