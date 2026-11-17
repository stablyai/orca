import { beforeEach, describe, expect, it, vi } from 'vitest'

// The attach flow with its network and pairing seams faked; the read-snapshot pin store is real
// (over an in-memory AsyncStorage), so these check when a grant's signer may replace a pinned one.
const { local, pairing, opened, saved, grants } = vi.hoisted(() => {
  const saved: { hostId: string | null } = { hostId: null }
  return {
    local: new Map<string, string>(),
    pairing: { ok: true },
    opened: { signer: 'S'.repeat(43) + '=' },
    saved,
    grants: { count: 0 }
  }
})
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
vi.mock('../host-catalog/host-store', () => ({
  updateHostNameAndEndpoint: async () => undefined
}))
vi.mock('./cloud-workspace-links', () => ({
  cloudWorkspaceHostId: async () => saved.hostId,
  recordCloudWorkspaceHost: async (_sandboxId: string, hostId: string | null) => {
    saved.hostId = hostId
  }
}))
vi.mock('./cloud-control-plane-access', () => ({
  requestCloudWorkspaceGrant: async () => {
    grants.count += 1
    return { grantId: 'g', sealed: {} }
  }
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
import { cloudStaleHostAction } from './cloud-host-pruning'
import { attachCloudWorkspace } from './cloud-workspace-attach'
import { commitCloudReadSnapshotPin, loadCloudReadSnapshotPin } from './cloud-read-snapshot-pins'

const OLD = 'O'.repeat(43) + '='
const NEW = 'N'.repeat(43) + '='
const plane: CloudControlPlane = { baseUrl: 'https://cloud.test', token: () => 't' }

const attach = (freshPairing = false) =>
  attachCloudWorkspace({
    plane,
    sandboxId: 'sbx',
    title: 'W',
    deviceLabel: 'Phone',
    onPhase: () => undefined,
    freshPairing
  })

beforeEach(async () => {
  local.clear()
  pairing.ok = true
  opened.signer = NEW
  saved.hostId = null
  grants.count = 0
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

  it('a normal wake with a saved host skips the grant and leaves the pin alone', async () => {
    saved.hostId = 'host-old'
    await expect(attach()).resolves.toEqual({ hostId: 'host-old', paired: false })
    expect(grants.count).toBe(0)
    expect((await loadCloudReadSnapshotPin('ds_1', 'sbx'))?.signerPublicKeyB64).toBe(OLD)
  })

  it('a fresh pairing skips the saved host, re-pins after pairing, and replaces the host', async () => {
    // Either trigger: the saved host's orcad refused us (cloudStaleHostAction), or the read view
    // saw the signer change. Both run this path.
    saved.hostId = 'host-old'
    await expect(attach(true)).resolves.toEqual({
      hostId: 'host-1',
      paired: true,
      replacedHostId: 'host-old'
    })
    expect(grants.count).toBe(1)
    expect(saved.hostId).toBe('host-1')
    expect((await loadCloudReadSnapshotPin('ds_1', 'sbx'))?.signerPublicKeyB64).toBe(NEW)
  })

  it('a fresh pairing that fails keeps the saved host and the pin', async () => {
    saved.hostId = 'host-old'
    pairing.ok = false
    await expect(attach(true)).rejects.toMatchObject({ code: 'pairing_failed' })
    expect(saved.hostId).toBe('host-old')
    expect((await loadCloudReadSnapshotPin('ds_1', 'sbx'))?.signerPublicKeyB64).toBe(OLD)
  })
})

describe('cloudStaleHostAction', () => {
  it('re-pairs a reused host whose orcad refused us, and only forgets a just-paired one', () => {
    expect(cloudStaleHostAction(true)).toBe('repair')
    expect(cloudStaleHostAction(false)).toBe('forget')
  })
})
