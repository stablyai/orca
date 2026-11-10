import { beforeEach, describe, expect, it, vi } from 'vitest'

const { secure, local } = vi.hoisted(() => ({
  secure: new Map<string, string>(),
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
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void secure.set(key, value),
  deleteItemAsync: async (key: string) => void secure.delete(key)
}))
vi.mock('./cloud-device-identity', () => ({
  loadCloudDeviceIdentity: async () => ({
    publicKeyB64: 'x',
    secretKey: new Uint8Array(64),
    enrollment: {
      controlPlaneUrl: 'https://cloud.test',
      deviceSessionId: 'ds_1',
      label: 'Phone',
      enrolledAt: 1
    }
  })
}))

import type { SealedReadSnapshot } from '../../../src/shared/cloud-workspaces/read-snapshot'
import { loadCloudReaderKey } from './cloud-reader-key'
import {
  PAYLOAD,
  fakePlane,
  registered,
  sealLikeVm,
  signLikeVm,
  vmSigner
} from './cloud-read-snapshot.test-fixture'

const KEY_ID = `rk_${'d'.repeat(24)}`
const SBX = 'sbx_sig'

async function seal(snapshotId: string, capturedAt: number): Promise<SealedReadSnapshot> {
  const key = await loadCloudReaderKey('ds_1')
  return sealLikeVm({
    readerPublicKeyB64: key.publicKeyB64,
    keyId: KEY_ID,
    workspaceId: SBX,
    snapshotId,
    payload: { ...PAYLOAD, workspaceId: SBX, snapshotId, capturedAt }
  })
}

/** A fresh import of the reader, as after an app relaunch: nothing survives but storage. */
async function freshReader() {
  vi.resetModules()
  return (await import('./cloud-read-snapshot')).readCloudWorkspaceSnapshot
}

function serving(next: () => SealedReadSnapshot) {
  return fakePlane((call) =>
    call.method === 'PUT' ? registered(KEY_ID) : { status: 200, body: { snapshot: next() } }
  ).plane
}

beforeEach(() => {
  secure.clear()
  local.clear()
})

describe('signed read snapshots', () => {
  it('opens a snapshot the workspace signed and pins its signer', async () => {
    const vm = vmSigner()
    const sealed = signLikeVm(await seal('snap_1', 1_000), vm)
    const read = await freshReader()
    expect(
      (
        await read(
          serving(() => sealed),
          SBX
        )
      ).state
    ).toBe('ready')
    const stored = JSON.parse(local.get('orca.cloud-read-pins.v1:ds_1') ?? '{}')
    expect(stored[SBX]).toMatchObject({
      signerPublicKeyB64: vm.publicKeyB64,
      newestCapturedAt: 1_000
    })
  })

  it('refuses a tampered body or a signature from another key over the same bytes', async () => {
    const vm = vmSigner()
    const good = signLikeVm(await seal('snap_1', 1_000), vm)
    const bytes = Buffer.from(good.ciphertextB64, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 1
    const tampered = { ...good, ciphertextB64: bytes.toString('base64') }
    const forged = {
      ...good,
      signature: {
        publicKeyB64: vm.publicKeyB64,
        signatureB64: signLikeVm(good, vmSigner()).signature?.signatureB64 ?? ''
      }
    }
    const read = await freshReader()
    for (const sealed of [tampered, forged]) {
      expect(
        await read(
          serving(() => sealed),
          SBX
        )
      ).toMatchObject({
        state: 'error',
        error: { name: 'CloudReadSnapshotRefusedError', reason: 'bad_signature' }
      })
    }
    // Nothing was pinned from a refused copy.
    expect(local.size).toBe(0)
  })

  it('refuses a copy re-signed by another key, or unsigned, once a signer is pinned', async () => {
    const vm = vmSigner()
    let next = signLikeVm(await seal('snap_1', 1_000), vm)
    const plane = serving(() => next)
    const read = await freshReader()
    expect((await read(plane, SBX)).state).toBe('ready')
    next = signLikeVm(await seal('snap_2', 2_000), vmSigner())
    expect(await read(plane, SBX)).toMatchObject({ error: { reason: 'signer_changed' } })
    next = await seal('snap_3', 3_000)
    expect(await read(plane, SBX)).toMatchObject({ error: { reason: 'unsigned' } })
    next = signLikeVm(await seal('snap_4', 4_000), vm)
    expect((await read(plane, SBX)).state).toBe('ready')
  })

  it('keeps the pin across relaunches (rollback and signer survive a fresh import)', async () => {
    const vm = vmSigner()
    let next = signLikeVm(await seal('snap_new', 5_000), vm)
    const plane = serving(() => next)
    expect((await (await freshReader())(plane, SBX)).state).toBe('ready')
    next = signLikeVm(await seal('snap_old', 4_000), vm)
    expect(await (await freshReader())(plane, SBX)).toMatchObject({
      error: { reason: 'rollback' }
    })
    next = signLikeVm(await seal('snap_other', 6_000), vmSigner())
    expect(await (await freshReader())(plane, SBX)).toMatchObject({
      error: { reason: 'signer_changed' }
    })
  })

  it('a grant fills an empty pin but never replaces a pinned signer', async () => {
    const vm = vmSigner()
    const forged = vmSigner()
    const pins = await import('./cloud-read-snapshot-pins')
    await pins.recordCloudReadSignerFromGrant('ds_1', SBX, vm.publicKeyB64)
    let next = signLikeVm(await seal('snap_1', 1_000), vm)
    const plane = serving(() => next)
    const read = await freshReader()
    expect((await read(plane, SBX)).state).toBe('ready')
    // A control plane forging a grant with its own key cannot re-pin.
    const fresh = await import('./cloud-read-snapshot-pins')
    await fresh.recordCloudReadSignerFromGrant('ds_1', SBX, forged.publicKeyB64)
    next = signLikeVm(await seal('snap_2', 2_000), forged)
    expect(await read(plane, SBX)).toMatchObject({ error: { reason: 'signer_changed' } })
    next = signLikeVm(await seal('snap_3', 3_000), vm)
    expect((await read(plane, SBX)).state).toBe('ready')
  })

  it('refuses a mismatched signer before decrypting (no reader secret is used on it)', async () => {
    const vm = vmSigner()
    let next = signLikeVm(await seal('snap_1', 1_000), vm)
    const plane = serving(() => next)
    const read = await freshReader()
    expect((await read(plane, SBX)).state).toBe('ready')
    // Undecryptable for this phone, but signed by another key: the signer check answers first.
    const other = await seal('snap_2', 2_000)
    next = signLikeVm(
      {
        ...other,
        recipient: { ...other.recipient, wrappedKeyB64: Buffer.alloc(48).toString('base64') }
      },
      vmSigner()
    )
    expect(await read(plane, SBX)).toMatchObject({ error: { reason: 'signer_changed' } })
    next = { ...next, signature: undefined }
    expect(await read(plane, SBX)).toMatchObject({ error: { reason: 'unsigned' } })
  })

  it('accepts unsigned copies while nothing is pinned (VMs from before signing)', async () => {
    const sealed = await seal('snap_1', 1_000)
    expect(
      (
        await (
          await freshReader()
        )(
          serving(() => sealed),
          SBX
        )
      ).state
    ).toBe('ready')
  })

  it('drops every session’s pins when the enrollment is cleared', async () => {
    const pins = await import('./cloud-read-snapshot-pins')
    await pins.recordCloudReadSignerFromGrant('ds_1', SBX, vmSigner().publicKeyB64)
    await pins.recordCloudReadSignerFromGrant('ds_2', SBX, vmSigner().publicKeyB64)
    local.set('unrelated', 'x')
    await pins.clearCloudReadSnapshotPins()
    expect([...local.keys()]).toEqual(['unrelated'])
  })
})
