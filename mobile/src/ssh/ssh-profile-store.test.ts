import { beforeEach, expect, it, vi } from 'vitest'
import { deleteSshProfile, loadSshProfiles, saveSshProfile } from './ssh-profile-store'
import type { SshProfile } from './ssh-profile'

const mocks = vi.hoisted(() => ({ metadata: new Map<string, string>() }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => mocks.metadata.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mocks.metadata.set(key, value)
    }
  }
}))

const profile: SshProfile = {
  id: 'profile-1',
  name: 'Jump box',
  host: 'server',
  port: 22,
  username: 'user',
  targetHost: 'localhost',
  hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`
}

beforeEach(() => {
  mocks.metadata.clear()
})

it('saves, lists and deletes profiles', async () => {
  await saveSshProfile(profile)
  expect(await loadSshProfiles()).toEqual([profile])
  await deleteSshProfile(profile.id)
  expect(await loadSshProfiles()).toEqual([])
})

it('replaces a saved profile with the same id', async () => {
  await saveSshProfile(profile)
  await saveSshProfile({ ...profile, name: 'Renamed' })
  const [stored] = await loadSshProfiles()
  expect(stored.name).toBe('Renamed')
  expect(await loadSshProfiles()).toHaveLength(1)
})

it('tolerates an empty store', async () => {
  expect(await loadSshProfiles()).toEqual([])
})

it('clears jump references when a profile is deleted', async () => {
  await saveSshProfile(profile)
  await saveSshProfile({
    id: 'profile-2',
    name: 'Inner',
    host: 'inner',
    port: 22,
    username: 'user',
    targetHost: 'localhost',
    hostKeyFingerprint: `SHA256:${'B'.repeat(43)}`,
    jumpProfileId: 'profile-1'
  })
  await deleteSshProfile('profile-1')
  const stored = await loadSshProfiles()
  expect(stored).toHaveLength(1)
  expect(stored[0]?.jumpProfileId).toBeUndefined()
})
