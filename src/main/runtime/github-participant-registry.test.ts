import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubParticipantRegistry } from './github-participant-registry'

const aliceAccount = { host: 'github.com', user: 'alice' }
const bobAccount = { host: 'github.com', user: 'bob' }
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-github-participants-'))
  directories.push(directory)
  const devices = new Map<string, { parentDeviceId?: string }>([
    ['alice-desktop', {}],
    ['alice-phone', { parentDeviceId: 'alice-desktop' }],
    ['bob-desktop', {}]
  ])
  const lookup = (id: string) => devices.get(id) ?? null
  const registry = new GitHubParticipantRegistry(directory, lookup)
  return {
    registry,
    directory,
    devices,
    reload: () => new GitHubParticipantRegistry(directory, lookup)
  }
}

describe('GitHubParticipantRegistry', () => {
  it('persists independent participant selections without enabling other repos', () => {
    const { registry, reload } = fixture()
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    registry.createParticipant({
      name: 'Bob',
      deviceIds: ['bob-desktop'],
      allowedAccounts: [bobAccount]
    })
    registry.setRepoEnabled('repo', true)
    registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    registry.selectAccount('repo', 'bob-desktop', bobAccount)
    const restored = reload()
    expect(restored.resolveAccount('repo', 'alice-phone')).toEqual({
      participantId: alice.id,
      account: aliceAccount
    })
    expect(restored.resolveAccount('repo', 'bob-desktop')?.account).toEqual(bobAccount)
    expect(restored.resolveAccount('legacy-repo', 'unknown')).toBeNull()
    expect(restored.getSelf('repo', 'alice-desktop').allowedAccounts).toEqual([aliceAccount])
  })

  it('rejects unknown devices, delegated-device assignments and duplicate membership', () => {
    const { registry } = fixture()
    registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    for (const deviceId of ['unknown', 'alice-phone', 'alice-desktop']) {
      expect(() =>
        registry.createParticipant({ name: 'Other', deviceIds: [deviceId], allowedAccounts: [] })
      ).toThrow()
    }
    expect(registry.listParticipants()).toHaveLength(1)
  })

  it('never falls back when membership, selection or account authorization is absent', () => {
    const { registry, devices } = fixture()
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    registry.setRepoEnabled('repo', true)
    expect(() => registry.resolveAccount('repo', 'bob-desktop')).toThrow(
      'github_participant_missing'
    )
    expect(() => registry.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_account_missing'
    )
    expect(() => registry.selectAccount('repo', 'alice-desktop', bobAccount)).toThrow(
      'github_participant_account_not_allowed'
    )
    registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    devices.delete('alice-desktop')
    expect(() => registry.resolveAccount('repo', 'alice-phone')).toThrow(
      'github_participant_device_revoked'
    )
    registry.updateParticipant(alice.id, { allowedAccounts: [] })
    expect(() => registry.resolveParticipantAccount('repo', alice.id, aliceAccount)).toThrow()
  })

  it('pins accepted account snapshots and refuses retargeting or removed owners', () => {
    const { registry } = fixture()
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount, bobAccount]
    })
    registry.setRepoEnabled('repo', true)
    registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    const accepted = registry.resolveAccount('repo', 'alice-desktop')!
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.account)).toBe(true)
    registry.selectAccount('repo', 'alice-desktop', bobAccount)
    expect(registry.resolveParticipantAccount('repo', alice.id, accepted.account)).toEqual(accepted)
    expect(accepted.account).toEqual(aliceAccount)
    registry.removeParticipant(alice.id)
    expect(() => registry.resolveParticipantAccount('repo', alice.id, accepted.account)).toThrow(
      'github_participant_missing'
    )
  })

  it('clears selections when disabling and requires fresh selection when re-enabled', () => {
    const { registry } = fixture()
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    registry.setRepoEnabled('repo', true)
    registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    registry.setRepoEnabled('repo', false)
    expect(registry.resolveAccount('repo', 'alice-desktop')).toBeNull()
    expect(() => registry.resolveParticipantAccount('repo', alice.id, aliceAccount)).toThrow(
      'github_participant_repo_disabled'
    )
    registry.setRepoEnabled('repo', true)
    expect(() => registry.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_account_missing'
    )
  })

  it('revokes device assignments immediately and isolates returned account lists', () => {
    const { registry } = fixture()
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    registry.setRepoEnabled('repo', true)
    registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    const status = registry.getSelf('repo', 'alice-phone')
    status.allowedAccounts.push(bobAccount)
    registry.listParticipants()[0].deviceIds.push('bob-desktop')
    expect(() => registry.selectAccount('repo', 'alice-desktop', bobAccount)).toThrow(
      'github_participant_account_not_allowed'
    )
    expect(() => registry.resolveAccount('repo', 'bob-desktop')).toThrow(
      'github_participant_missing'
    )
    registry.updateParticipant(alice.id, { deviceIds: [] })
    expect(() => registry.resolveAccount('repo', 'alice-phone')).toThrow(
      'github_participant_missing'
    )
  })

  it('stops authorization after a failed durable update instead of using stale grants', () => {
    const { registry, directory } = fixture()
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    registry.setRepoEnabled('repo', true)
    registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    const path = join(directory, 'github-participants.json')
    rmSync(path)
    mkdirSync(path)
    expect(() => registry.updateParticipant(alice.id, { allowedAccounts: [] })).toThrow()
    expect(() => registry.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_registry_unavailable'
    )
  })

  it('fails closed on malformed storage and never overwrites it', () => {
    const { directory, reload } = fixture()
    const path = join(directory, 'github-participants.json')
    writeFileSync(path, '{broken')
    const registry = reload()
    expect(() => registry.isRepoEnabled('repo')).toThrow('github_participant_registry_unavailable')
    expect(() => registry.setRepoEnabled('repo', true)).toThrow(
      'github_participant_registry_unavailable'
    )
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('rejects stored selections without a matching participant grant', () => {
    const { directory, reload } = fixture()
    writeFileSync(
      join(directory, 'github-participants.json'),
      JSON.stringify({
        version: 1,
        participants: [
          {
            id: 'alice',
            name: 'Alice',
            deviceIds: ['alice-desktop'],
            allowedAccounts: [aliceAccount]
          }
        ],
        enabledRepoIds: ['repo'],
        selections: [{ repoId: 'repo', participantId: 'alice', account: bobAccount }]
      })
    )
    expect(() => reload().resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_registry_unavailable'
    )
  })
})
