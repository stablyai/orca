import { beforeEach, expect, it, vi } from 'vitest'
import { cleanupSshCredentials, updateHostConnectionRoute } from './host-connection-route-store'
import { ConnectionRouteSchema } from './connection-route'
import { readStoredHostProfilesForMutation, toStoredHostProfile } from './host-metadata-store'
import { beginSshCredentialDraft, finishSshCredentialDraft } from './ssh-credential-registry'
import { deleteSshProfile as deleteSshProfileForTest } from '../ssh/ssh-profile-store'

const mocks = vi.hoisted(() => ({ metadata: new Map<string, string>(), delete: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => mocks.metadata.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mocks.metadata.set(key, value)
    }
  }
}))
vi.mock('./ssh-route-credentials', () => ({ deleteSshRouteCredentials: mocks.delete }))

const route = ConnectionRouteSchema.parse({
  kind: 'ssh',
  host: 'server',
  port: 22,
  username: 'user',
  targetHost: 'localhost',
  targetPort: 6768,
  hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
  credentialId: 'new-id'
})
const host = {
  id: 'host-1',
  name: 'Server',
  personalName: 'Server',
  endpoint: 'ws://server:6768',
  publicKeyB64: 'pin',
  lastConnected: 0
}
beforeEach(() => {
  mocks.metadata.clear()
  mocks.metadata.set('orca:hosts', JSON.stringify([host]))
  mocks.delete.mockReset().mockResolvedValue(undefined)
})

it('roundtrips the route without persisting a credential or changing the server endpoint', async () => {
  await updateHostConnectionRoute(host.id, route)
  const [stored] = await readStoredHostProfilesForMutation()
  expect(stored).toEqual({ ...host, connectionRoute: route })
  expect(
    toStoredHostProfile({ ...host, connectionRoute: route, deviceToken: 'secret-token' })
  ).toEqual(stored)
  expect(mocks.metadata.get('orca:hosts')).not.toContain('secret-token')
  await updateHostConnectionRoute(host.id, null)
  expect(await readStoredHostProfilesForMutation()).toEqual([host])
})

it('does not resurrect a removed host when connection testing finishes late', async () => {
  mocks.metadata.set('orca:hosts', '[]')
  await expect(updateHostConnectionRoute(host.id, route)).rejects.toThrow('removed')
  expect(await readStoredHostProfilesForMutation()).toEqual([])
})

it('retains in-progress and committed credentials, then deletes superseded credentials', async () => {
  await beginSshCredentialDraft('new-id')
  await cleanupSshCredentials()
  expect(mocks.delete).not.toHaveBeenCalled()
  await updateHostConnectionRoute(host.id, route)
  finishSshCredentialDraft('new-id')
  await cleanupSshCredentials()
  expect(mocks.delete).not.toHaveBeenCalled()
  await updateHostConnectionRoute(host.id, null)
  await cleanupSshCredentials()
  expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('new-id')
  expect(mocks.metadata.get('orca:ssh-credential-ids')).toBe('[]')
})

it('retains credentials referenced by a saved SSH profile', async () => {
  mocks.metadata.set('orca:ssh-credential-ids', '["profile-id"]')
  mocks.metadata.set(
    'orca:ssh-connection-profiles',
    JSON.stringify([
      {
        id: 'profile-id',
        name: 'Jump box',
        host: 'server',
        port: 22,
        username: 'user',
        targetHost: 'localhost',
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`
      }
    ])
  )
  await cleanupSshCredentials()
  expect(mocks.delete).not.toHaveBeenCalled()
  await deleteSshProfileForTest('profile-id')
  await cleanupSshCredentials()
  expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('profile-id')
})

it('retries failed secure deletion on a later cleanup', async () => {
  mocks.metadata.set('orca:ssh-credential-ids', '["orphan"]')
  mocks.delete.mockRejectedValueOnce(new Error('keychain locked'))
  await cleanupSshCredentials()
  expect(mocks.metadata.get('orca:ssh-credential-ids')).toBe('["orphan"]')
  await cleanupSshCredentials()
  expect(mocks.delete).toHaveBeenCalledTimes(2)
  expect(mocks.metadata.get('orca:ssh-credential-ids')).toBe('[]')
})

it('does not delete credentials when host storage is unreadable', async () => {
  mocks.metadata.set('orca:ssh-credential-ids', '["orphan"]')
  mocks.metadata.set('orca:hosts', 'corrupt')
  await expect(cleanupSshCredentials()).rejects.toThrow('unreadable')
  expect(mocks.delete).not.toHaveBeenCalled()
})
