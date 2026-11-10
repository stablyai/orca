import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, local } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  local: new Map<string, string>()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => local.get(key) ?? null,
    setItem: async (key: string, value: string) => void local.set(key, value),
    getAllKeys: async () => [...local.keys()],
    multiRemove: async (keys: string[]) => keys.forEach((key) => local.delete(key))
  }
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key)
}))
vi.mock('./cloud-device-identity', () => ({
  loadCloudDeviceIdentity: async () => ({
    publicKeyB64: 'x',
    secretKey: new Uint8Array(64),
    enrollment: {
      controlPlaneUrl: 'https://cloud.test',
      deviceSessionId: 'ds_1',
      label: 'Neil’s iPhone',
      enrolledAt: 1
    }
  })
}))

import {
  CLOUD_READER_KEY_REFRESH_MS,
  ensureCloudReaderKey,
  readCloudWorkspaceSnapshot
} from './cloud-read-snapshot'
import { PAYLOAD, fakePlane, registered, sealLikeVm } from './cloud-read-snapshot.test-fixture'
import { loadCloudReaderKey } from './cloud-reader-key'

beforeEach(() => {
  store.clear()
  local.clear()
})

describe('ensureCloudReaderKey', () => {
  it('registers once as a mobile key, then only again after 6 h or when forced', async () => {
    let clock = 1_000
    const now = () => clock
    const { plane, calls } = fakePlane(() => registered())
    const first = await ensureCloudReaderKey(plane, { now })
    const key = await loadCloudReaderKey('ds_1')
    expect(first?.keyId).toBe('rk_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://cloud.test/v1/reader-keys',
      body: { publicKeyB64: key.publicKeyB64, deviceLabel: 'Neil’s iPhone', deviceKind: 'mobile' }
    })
    await ensureCloudReaderKey(plane, { now })
    expect(calls).toHaveLength(1)
    clock += CLOUD_READER_KEY_REFRESH_MS
    await ensureCloudReaderKey(plane, { now })
    expect(calls).toHaveLength(2)
    await ensureCloudReaderKey(plane, { now, force: true })
    expect(calls).toHaveLength(3)
  })
})

describe('readCloudWorkspaceSnapshot', () => {
  it('opens a snapshot the VM sealed to this phone (node:crypto seal, Hermes primitives open)', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const keyId = 'rk_bbbbbbbbbbbbbbbbbbbbbbbb'
    const sealed = sealLikeVm({
      readerPublicKeyB64: key.publicKeyB64,
      keyId,
      workspaceId: 'sbx_1',
      snapshotId: 'snap_1',
      payload: PAYLOAD
    })
    const { plane, calls } = fakePlane((call) =>
      call.method === 'PUT' ? registered(keyId) : { status: 200, body: { snapshot: sealed } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(calls[1]?.url).toBe(
      `https://cloud.test/v1/team/workspaces/sbx_1/read-snapshot?keyId=${keyId}`
    )
    expect(calls.some((call) => /wake/.test(call.url))).toBe(false)
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') {
      return
    }
    expect(result.snapshot.capturedAt).toBe(PAYLOAD.capturedAt)
    expect(result.snapshot.pr?.number).toBe(42)
    expect(result.snapshot.git?.branch).toBe('fix-login')
    expect(result.snapshot.sessions[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('refuses a snapshot sealed for another workspace', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const sealed = sealLikeVm({
      readerPublicKeyB64: key.publicKeyB64,
      keyId: 'rk_111111111111111111111111',
      workspaceId: 'sbx_other',
      snapshotId: 'snap_1',
      payload: { ...PAYLOAD, workspaceId: 'sbx_other' }
    })
    const { plane } = fakePlane((call) =>
      call.method === 'PUT'
        ? registered('rk_111111111111111111111111')
        : { status: 200, body: { snapshot: sealed } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(result.state).toBe('error')
  })

  it('fails closed when the wrapped key is for another key id', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const sealed = sealLikeVm({
      readerPublicKeyB64: key.publicKeyB64,
      keyId: 'rk_111111111111111111111111',
      workspaceId: 'sbx_1',
      snapshotId: 'snap_1',
      payload: PAYLOAD
    })
    sealed.recipient.keyId = 'rk_222222222222222222222222'
    const { plane } = fakePlane((call) =>
      call.method === 'PUT'
        ? registered('rk_222222222222222222222222')
        : { status: 200, body: { snapshot: sealed } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(result).toMatchObject({ state: 'error', error: { code: 'decrypt_failed' } })
  })

  it.each(['no_snapshot', 'not_sealed_for_key', 'not_found'] as const)(
    'maps 404 %s to its state',
    async (code) => {
      const { plane } = fakePlane((call) =>
        call.method === 'PUT' ? registered() : { status: 404, body: { error: code } }
      )
      await expect(readCloudWorkspaceSnapshot(plane, 'sbx_1')).resolves.toEqual({ state: code })
    }
  )

  it('does not renew the key on not_sealed_for_key', async () => {
    const { plane, calls } = fakePlane((call) =>
      call.method === 'PUT' ? registered() : { status: 404, body: { error: 'not_sealed_for_key' } }
    )
    await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET'])
  })

  it('refuses a snapshot older than one already shown for the workspace (rollback pin)', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const keyId = `rk_${'c'.repeat(24)}`
    const seal = (snapshotId: string, capturedAt: number) =>
      sealLikeVm({
        readerPublicKeyB64: key.publicKeyB64,
        keyId,
        workspaceId: 'sbx_pin',
        snapshotId,
        payload: { ...PAYLOAD, workspaceId: 'sbx_pin', snapshotId, capturedAt }
      })
    let next = seal('snap_new', 2_000)
    const { plane } = fakePlane((call) =>
      call.method === 'PUT' ? registered(keyId) : { status: 200, body: { snapshot: next } }
    )
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('ready')
    next = seal('snap_old', 1_000)
    expect(await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).toMatchObject({
      state: 'error',
      error: { name: 'CloudReadSnapshotRefusedError', reason: 'rollback' }
    })
    next = seal('snap_same', 2_000)
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('ready')
    next = seal('snap_newer', 3_000)
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('ready')
    next = seal('snap_same', 2_000)
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('error')
  })

  it('re-registers once on invalid_request and asks again', async () => {
    let gets = 0
    const { plane, calls } = fakePlane((call) => {
      if (call.method === 'PUT') {
        return registered(
          gets === 0 ? 'rk_000000000000000000000000' : 'rk_ffffffffffffffffffffffff'
        )
      }
      gets += 1
      return gets === 1
        ? { status: 400, body: { error: 'invalid_request' } }
        : { status: 404, body: { error: 'no_snapshot' } }
    })
    await expect(readCloudWorkspaceSnapshot(plane, 'sbx_1')).resolves.toEqual({
      state: 'no_snapshot'
    })
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'PUT', 'GET'])
    expect(calls[3]?.url).toContain('keyId=rk_ffffffffffffffffffffffff')
  })

  it('returns a 401 as an error carrying the status, for the caller to forget the session', async () => {
    const { plane } = fakePlane((call) =>
      call.method === 'PUT' ? registered() : { status: 401, body: { error: 'unauthorized' } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(result).toMatchObject({ state: 'error', error: { status: 401 } })
  })

  it('returns a malformed reply as an error', async () => {
    const { plane } = fakePlane((call) =>
      call.method === 'PUT' ? registered() : { status: 200, body: { snapshot: { v: 2 } } }
    )
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_1')).state).toBe('error')
  })
})
