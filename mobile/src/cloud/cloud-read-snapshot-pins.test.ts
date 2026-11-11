import { beforeEach, describe, expect, it, vi } from 'vitest'

const { local } = vi.hoisted(() => ({ local: new Map<string, string>() }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => local.get(key) ?? null,
    setItem: async (key: string, value: string) => void local.set(key, value),
    getAllKeys: async () => [...local.keys()],
    multiRemove: async (keys: string[]) => keys.forEach((key) => local.delete(key))
  }
}))

import {
  commitCloudReadSnapshotPin,
  loadCloudReadSnapshotPin,
  recordCloudReadSignerFromGrant,
  repinCloudReadSignerAfterPairing
} from './cloud-read-snapshot-pins'

const A = 'A'.repeat(43) + '='
const B = 'B'.repeat(43) + '='
const C = 'C'.repeat(43) + '='

beforeEach(() => local.clear())

describe('cloud read snapshot pins', () => {
  it('a grant fills an empty pin only', async () => {
    await recordCloudReadSignerFromGrant('ds', 'sbx', A)
    await recordCloudReadSignerFromGrant('ds', 'sbx', B)
    expect(await loadCloudReadSnapshotPin('ds', 'sbx')).toEqual({
      signerPublicKeyB64: A,
      newestCapturedAt: 0
    })
  })

  it('concurrent saves never move the capture floor back', async () => {
    await Promise.all([
      commitCloudReadSnapshotPin('ds', 'sbx', null, {
        signerPublicKeyB64: A,
        newestCapturedAt: 5_000
      }),
      commitCloudReadSnapshotPin('ds', 'sbx', null, {
        signerPublicKeyB64: A,
        newestCapturedAt: 1_000
      })
    ])
    expect((await loadCloudReadSnapshotPin('ds', 'sbx'))?.newestCapturedAt).toBe(5_000)
  })

  it('a stale read cannot overwrite a grant pin that landed after it', async () => {
    // The read decided against "nothing pinned"; a grant pinned B before it wrote.
    await recordCloudReadSignerFromGrant('ds', 'sbx', B)
    await commitCloudReadSnapshotPin('ds', 'sbx', null, {
      signerPublicKeyB64: C,
      newestCapturedAt: 9
    })
    expect(await loadCloudReadSnapshotPin('ds', 'sbx')).toEqual({
      signerPublicKeyB64: B,
      newestCapturedAt: 9
    })
  })

  it('a re-pin after pairing replaces the signer, keeps the floor, and a stale read cannot undo it', async () => {
    const pinned = { signerPublicKeyB64: A, newestCapturedAt: 1_000 }
    await commitCloudReadSnapshotPin('ds', 'sbx', null, pinned)
    await repinCloudReadSignerAfterPairing('ds', 'sbx', B)
    expect(await loadCloudReadSnapshotPin('ds', 'sbx')).toEqual({
      signerPublicKeyB64: B,
      newestCapturedAt: 1_000
    })
    // A read that decided against A finishes after the re-pin: the floor moves, the signer stays B.
    await commitCloudReadSnapshotPin('ds', 'sbx', pinned, {
      signerPublicKeyB64: A,
      newestCapturedAt: 2_000
    })
    expect(await loadCloudReadSnapshotPin('ds', 'sbx')).toEqual({
      signerPublicKeyB64: B,
      newestCapturedAt: 2_000
    })
  })

  it('keeps sessions apart', async () => {
    await recordCloudReadSignerFromGrant('ds_1', 'sbx', A)
    expect(await loadCloudReadSnapshotPin('ds_2', 'sbx')).toBeNull()
  })

  it('evicts the least recently used workspace, not the oldest capture', async () => {
    // An old capture used just now outlives newer captures nobody has looked at since.
    for (let i = 0; i < 300; i += 1) {
      await commitCloudReadSnapshotPin(
        'ds',
        `sbx_${i}`,
        null,
        { signerPublicKeyB64: A, newestCapturedAt: 10_000 + i },
        1_000 + i
      )
    }
    await commitCloudReadSnapshotPin(
      'ds',
      'sbx_0',
      null,
      { signerPublicKeyB64: A, newestCapturedAt: 1 },
      5_000
    )
    await commitCloudReadSnapshotPin(
      'ds',
      'sbx_new',
      null,
      { signerPublicKeyB64: A, newestCapturedAt: 1 },
      6_000
    )
    expect(await loadCloudReadSnapshotPin('ds', 'sbx_0')).not.toBeNull()
    expect(await loadCloudReadSnapshotPin('ds', 'sbx_1')).toBeNull()
    expect(await loadCloudReadSnapshotPin('ds', 'sbx_new')).not.toBeNull()
  })
})
