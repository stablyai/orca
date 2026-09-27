import { beforeEach, expect, it, vi } from 'vitest'
import {
  deleteSshRouteCredentials,
  readSshRouteCredentials,
  writeSshRouteCredentials
} from './ssh-route-credentials'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('./pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => storage.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => {
    storage.set(key, value)
  },
  deletePairingKeychainItem: async (key: string) => {
    storage.delete(key)
  }
}))
beforeEach(() => storage.clear())

it('roundtrips a large key and Unicode passphrase in bounded secure-store entries', async () => {
  const credential = {
    kind: 'key' as const,
    privateKey: '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(16000),
    passphrase: '秘密🐳'.repeat(200)
  }
  await writeSshRouteCredentials('new-id', credential)
  expect(
    Math.max(...[...storage.values()].map((value) => new TextEncoder().encode(value).length))
  ).toBeLessThanOrEqual(1500)
  await expect(readSshRouteCredentials('new-id')).resolves.toEqual(credential)
  await deleteSshRouteCredentials('new-id')
  expect(storage.size).toBe(0)
})

it('refuses incomplete or invalid secure storage rather than dialing without authentication', async () => {
  await writeSshRouteCredentials('new-id', { kind: 'password', password: 'secret' })
  storage.delete('orca.ssh.new-id.0')
  await expect(readSshRouteCredentials('new-id')).rejects.toThrow('incomplete')
  storage.set('orca.ssh.new-id', '999999999')
  await expect(readSshRouteCredentials('new-id')).rejects.toThrow('unreadable')
})
