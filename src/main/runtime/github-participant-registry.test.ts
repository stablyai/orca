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
    reload: async () => {
      const restored = new GitHubParticipantRegistry(directory, lookup)
      await restored.ready()
      return restored
    }
  }
}

describe('GitHubParticipantRegistry', () => {
  it('withholds authorization until initialization finishes', async () => {
    const { registry } = fixture()
    expect(registry.hasEnabledRepos()).toBe(true)
    expect(() => registry.isRepoEnabled('repo')).toThrow('github_participant_registry_unavailable')
    await registry.ready()
    expect(registry.hasEnabledRepos()).toBe(false)
  })

  it('serializes concurrent membership changes before persisting their combined state', async () => {
    const { registry, reload } = fixture()
    const results = await Promise.allSettled([
      registry.createParticipant({
        name: 'Alice',
        deviceIds: ['alice-desktop'],
        allowedAccounts: [aliceAccount]
      }),
      registry.createParticipant({
        name: 'Bob',
        deviceIds: ['bob-desktop'],
        allowedAccounts: [bobAccount]
      }),
      registry.createParticipant({
        name: 'Impersonator',
        deviceIds: ['alice-desktop'],
        allowedAccounts: [aliceAccount]
      })
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(results[2]).toMatchObject({
      status: 'rejected',
      reason: new Error('github_participant_device_already_assigned')
    })
    const restored = await reload()
    expect(restored.listParticipants().map((participant) => participant.name)).toEqual([
      'Alice',
      'Bob'
    ])
  })

  it('persists independent participant selections without enabling other repos', async () => {
    const { registry, reload } = fixture()
    const alice = await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    await registry.createParticipant({
      name: 'Bob',
      deviceIds: ['bob-desktop'],
      allowedAccounts: [bobAccount]
    })
    await registry.setRepoEnabled('repo', true)
    await registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    await registry.selectAccount('repo', 'bob-desktop', bobAccount)
    const restored = await reload()
    expect(restored.resolveAccount('repo', 'alice-phone')).toEqual({
      participantId: alice.id,
      account: aliceAccount
    })
    expect(restored.resolveAccount('repo', 'bob-desktop')?.account).toEqual(bobAccount)
    expect(restored.resolveAccount('legacy-repo', 'unknown')).toBeNull()
    expect(restored.getSelf('repo', 'alice-desktop').allowedAccounts).toEqual([aliceAccount])
  })

  it('rejects unknown devices, delegated-device assignments and duplicate membership', async () => {
    const { registry } = fixture()
    await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    for (const deviceId of ['unknown', 'alice-phone', 'alice-desktop']) {
      await expect(
        registry.createParticipant({ name: 'Other', deviceIds: [deviceId], allowedAccounts: [] })
      ).rejects.toThrow()
    }
    expect(registry.listParticipants()).toHaveLength(1)
  })

  it('never falls back when membership, selection or account authorization is absent', async () => {
    const { registry, devices } = fixture()
    const alice = await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    await registry.setRepoEnabled('repo', true)
    expect(() => registry.resolveAccount('repo', 'bob-desktop')).toThrow(
      'github_participant_missing'
    )
    expect(() => registry.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_account_missing'
    )
    await expect(registry.selectAccount('repo', 'alice-desktop', bobAccount)).rejects.toThrow(
      'github_participant_account_not_allowed'
    )
    await registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    devices.delete('alice-desktop')
    expect(() => registry.resolveAccount('repo', 'alice-phone')).toThrow(
      'github_participant_device_revoked'
    )
    await registry.updateParticipant(alice.id, { allowedAccounts: [] })
    expect(() => registry.resolveParticipantAccount('repo', alice.id, aliceAccount)).toThrow()
  })

  it('pins accepted account snapshots and refuses retargeting or removed owners', async () => {
    const { registry } = fixture()
    const alice = await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount, bobAccount]
    })
    await registry.setRepoEnabled('repo', true)
    await registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    const accepted = registry.resolveAccount('repo', 'alice-desktop')!
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.account)).toBe(true)
    await registry.selectAccount('repo', 'alice-desktop', bobAccount)
    expect(registry.resolveParticipantAccount('repo', alice.id, accepted.account)).toEqual(accepted)
    expect(accepted.account).toEqual(aliceAccount)
    await registry.removeParticipant(alice.id)
    expect(() => registry.resolveParticipantAccount('repo', alice.id, accepted.account)).toThrow(
      'github_participant_missing'
    )
  })

  it('clears selections when disabling and requires fresh selection when re-enabled', async () => {
    const { registry } = fixture()
    const alice = await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    await registry.setRepoEnabled('repo', true)
    await registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    await registry.setRepoEnabled('repo', false)
    expect(registry.resolveAccount('repo', 'alice-desktop')).toBeNull()
    expect(() => registry.resolveParticipantAccount('repo', alice.id, aliceAccount)).toThrow(
      'github_participant_repo_disabled'
    )
    await registry.setRepoEnabled('repo', true)
    expect(() => registry.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_account_missing'
    )
  })

  it('revokes device assignments immediately and isolates returned account lists', async () => {
    const { registry } = fixture()
    const alice = await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    await registry.setRepoEnabled('repo', true)
    await registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    const status = registry.getSelf('repo', 'alice-phone')
    status.allowedAccounts.push(bobAccount)
    registry.listParticipants()[0].deviceIds.push('bob-desktop')
    await expect(registry.selectAccount('repo', 'alice-desktop', bobAccount)).rejects.toThrow(
      'github_participant_account_not_allowed'
    )
    expect(() => registry.resolveAccount('repo', 'bob-desktop')).toThrow(
      'github_participant_missing'
    )
    await registry.updateParticipant(alice.id, { deviceIds: [] })
    expect(() => registry.resolveAccount('repo', 'alice-phone')).toThrow(
      'github_participant_missing'
    )
  })

  it('stops authorization after a failed durable update instead of using stale grants', async () => {
    const { registry, directory } = fixture()
    const alice = await registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice-desktop'],
      allowedAccounts: [aliceAccount]
    })
    await registry.setRepoEnabled('repo', true)
    await registry.selectAccount('repo', 'alice-desktop', aliceAccount)
    const path = join(directory, 'github-participants.json')
    rmSync(path)
    mkdirSync(path)
    await expect(registry.updateParticipant(alice.id, { allowedAccounts: [] })).rejects.toThrow()
    expect(() => registry.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_registry_unavailable'
    )
  })

  it('fails closed on malformed storage and never overwrites it', async () => {
    const { directory, reload } = fixture()
    const path = join(directory, 'github-participants.json')
    writeFileSync(path, '{broken')
    const registry = await reload()
    await expect(registry.ready()).resolves.toBeUndefined()
    expect(() => registry.isRepoEnabled('repo')).toThrow('github_participant_registry_unavailable')
    await expect(registry.setRepoEnabled('repo', true)).rejects.toThrow(
      'github_participant_registry_unavailable'
    )
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('rejects stored selections without a matching participant grant', async () => {
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
    const restored = await reload()
    expect(() => restored.resolveAccount('repo', 'alice-desktop')).toThrow(
      'github_participant_registry_unavailable'
    )
  })
})
