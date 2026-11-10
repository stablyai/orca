import { beforeEach, describe, expect, it, vi } from 'vitest'

// The attach flow with its network and pairing seams faked; the read-snapshot pin store is real
// (over an in-memory AsyncStorage), so these check when a grant's signer may replace a pinned one.
const { local, pairing, opened } = vi.hoisted(() => ({
  local: new Map<string, string>(),
  pairing: { ok: true },
  opened: { signer: 'S'.repeat(43) + '=' }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => local.get(key) ?? null,
    setItem: async (key: string, value: string) => void local.set(key, value),
    getAllKeys: async () => [...local.keys()],
    multiRemove: async (keys: string[]) => keys.forEach((key) => local.delete(key))
  }
}))
vi.mock('../pairing/pairing', () => ({ parsePairingCode: () => ({ offer: true }) }))
vi.mock('../pairing/pre-profile-pairing-coordinator', () => ({
  startPreProfilePairing: () => ({
    result: pairing.ok
      ? Promise.resolve({ hostId: 'host-1' })
      : Promise.reject(new Error('handshake failed')),
    dispose: () => undefined
  })
}))
vi.mock('../transport/hosts/host-store', () => ({
  updateHostNameAndEndpoint: async () => undefined
}))
vi.mock('./cloud-workspace-links', () => ({
  cloudWorkspaceHostId: async () => null,
  recordCloudWorkspaceHost: async () => undefined
}))
vi.mock('./cloud-control-plane-access', () => ({
  requestCloudWorkspaceGrant: async () => ({ grantId: 'g', sealed: {} })
}))
vi.mock('./cloud-control-plane-client', () => ({
  wakeCloudWorkspace: async () => ({ state: 'ready', endpoint: null })
}))
vi.mock('./cloud-sealed-grant', () => ({
  createGrantRecipientKey: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  openCloudSealedGrant: async () => ({
    pairingUrl: 'orca://pair?code=x',
    deviceId: 'd',
    scope: 'mobile',
    readSignerPublicKeyB64: opened.signer
  })
}))
vi.mock('./cloud-device-identity', () => ({
  loadCloudDeviceIdentity: async () => ({ enrollment: { deviceSessionId: 'ds_1' } })
}))

import type { CloudControlPlane } from './cloud-control-plane-request'
import { attachCloudWorkspace } from './cloud-workspace-attach'
import { commitCloudReadSnapshotPin, loadCloudReadSnapshotPin } from './cloud-read-snapshot-pins'

const OLD = 'O'.repeat(43) + '='
const NEW = 'N'.repeat(43) + '='
const plane: CloudControlPlane = { baseUrl: 'https://cloud.test', token: () => 't' }

const attach = () =>
  attachCloudWorkspace({
    plane,
    sandboxId: 'sbx',
    title: 'W',
    deviceLabel: 'Phone',
    onPhase: () => undefined
  })

beforeEach(async () => {
  local.clear()
  pairing.ok = true
  opened.signer = NEW
  await commitCloudReadSnapshotPin('ds_1', 'sbx', null, {
    signerPublicKeyB64: OLD,
    newestCapturedAt: 1_000
  })
})

describe('attach and the read-snapshot signer pin', () => {
  it('re-pins to the grant’s signer once its pairing succeeds, keeping the floor', async () => {
    await expect(attach()).resolves.toEqual({ hostId: 'host-1', paired: true })
    expect(await loadCloudReadSnapshotPin('ds_1', 'sbx')).toEqual({
      signerPublicKeyB64: NEW,
      newestCapturedAt: 1_000
    })
  })

  it('does not re-pin when the pairing fails (a grant opened but never paired)', async () => {
    pairing.ok = false
    await expect(attach()).rejects.toMatchObject({ code: 'pairing_failed' })
    expect((await loadCloudReadSnapshotPin('ds_1', 'sbx'))?.signerPublicKeyB64).toBe(OLD)
  })

  it('fills an empty pin from the grant even before pairing', async () => {
    local.clear()
    pairing.ok = false
    await expect(attach()).rejects.toMatchObject({ code: 'pairing_failed' })
    expect((await loadCloudReadSnapshotPin('ds_1', 'sbx'))?.signerPublicKeyB64).toBe(NEW)
  })
})
