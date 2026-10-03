import { expect, it } from 'vitest'
import { emptySshConnectionForm } from './ssh-connection-form'
import {
  assertNoJumpCycle,
  parseSshProfileForm,
  routeFromSshProfile,
  type SshProfile
} from './ssh-profile'

const valid = {
  ...emptySshConnectionForm,
  name: 'Jump box',
  host: 'server',
  username: 'user',
  hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
  auth: 'password' as const,
  password: 'secret'
}

it('separates nonsecret profile metadata from the SSH credential', () => {
  const parsed = parseSshProfileForm(valid, 'profile-id')
  expect(parsed.profile).toEqual({
    id: 'profile-id',
    name: 'Jump box',
    host: 'server',
    port: 22,
    username: 'user',
    targetHost: 'localhost',
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`
  })
  expect(parsed.credentials).toEqual({ kind: 'password', password: 'secret' })
})

it('keeps an explicit socket target set by the user', () => {
  const parsed = parseSshProfileForm(
    { ...valid, targetHost: 'internal-name', targetPort: '6769' },
    'profile-id'
  )
  expect(parsed.profile.targetHost).toBe('internal-name')
  expect(parsed.profile.targetPort).toBe(6769)
})

it('defaults the route target port to the paired endpoint port', () => {
  const { profile } = parseSshProfileForm(valid, 'profile-id')
  expect(routeFromSshProfile(profile, 6768).targetPort).toBe(6768)
  expect(routeFromSshProfile(profile, 6768).targetHost).toBe('localhost')
  expect(routeFromSshProfile(profile, 6768).credentialId).toBe('profile-id')
})

it('requires a name', () => {
  expect(() => parseSshProfileForm({ ...valid, name: '  ' }, 'profile-id')).toThrow('name')
})

it.each(['0', '65536', '1.5', '22abc', ''])('rejects invalid port %s', (port) => {
  expect(() => parseSshProfileForm({ ...valid, port }, 'profile-id')).toThrow()
})

it('requires an explicit host-key fingerprint and never infers trust from a pairing code', () => {
  expect(() => parseSshProfileForm({ ...valid, hostKeyFingerprint: '' }, 'profile-id')).toThrow(
    'verified'
  )
})

const jumpProfile: SshProfile = {
  id: 'jump-id',
  name: 'Jump box',
  host: 'jump.example',
  port: 22,
  username: 'jump-user',
  targetHost: 'localhost',
  hostKeyFingerprint: `SHA256:${'B'.repeat(43)}`
}

it('references another saved profile as the jump host', () => {
  const parsed = parseSshProfileForm({ ...valid, jumpProfileId: 'jump-id' }, 'profile-id')
  expect(parsed.profile.jumpProfileId).toBe('jump-id')
  const route = routeFromSshProfile(parsed.profile, 6768, jumpProfile)
  expect(route.jump).toEqual({
    host: 'jump.example',
    port: 22,
    username: 'jump-user',
    hostKeyFingerprint: `SHA256:${'B'.repeat(43)}`,
    credentialId: 'jump-id'
  })
})

it('rejects a jump chain that loops back on itself', () => {
  const parsed = parseSshProfileForm({ ...valid, jumpProfileId: 'jump-id' }, 'profile-id')
  expect(() =>
    assertNoJumpCycle(parsed.profile, [
      parsed.profile,
      { ...jumpProfile, jumpProfileId: 'profile-id' }
    ])
  ).toThrow('loop')
})
