import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubParticipantRegistry } from './github-participant-registry'
import { GitHubParticipantSettingsController } from './github-participant-settings'
import { runWithGitHubExecutionIdentity } from './github-participant-execution'
import type { GhAccountBinding } from '../../shared/github/account-binding'
import type { GhAccountBindingValidationResult } from '../../shared/github/auth-types'

const alice = { host: 'github.com', user: 'alice' }
const bob = { host: 'github.com', user: 'bob' }
const owner = { kind: 'desktop' } as const
const caller = { kind: 'paired-device', deviceId: 'alice-device' } as const
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-github-participant-settings-'))
  directories.push(directory)
  const registry = new GitHubParticipantRegistry(directory, (id) =>
    id === 'alice-device' || id === 'bob-device' ? {} : null
  )
  const member = registry.createParticipant({
    name: 'Alice',
    deviceIds: ['alice-device'],
    allowedAccounts: [alice]
  })
  registry.createParticipant({ name: 'Bob', deviceIds: ['bob-device'], allowedAccounts: [bob] })
  registry.setRepoEnabled('repo', true)
  const validate = vi.fn(
    async (
      _repo: string,
      binding: GhAccountBinding
    ): Promise<GhAccountBindingValidationResult> => ({ ok: true, binding })
  )
  const controller = new GitHubParticipantSettingsController({
    registry,
    resolveRepo: async () => ({ id: 'repo', ghAccount: bob }),
    listDevices: () => [
      { deviceId: 'alice-device', name: 'Alice laptop' },
      { deviceId: 'bob-device', name: 'Bob laptop' }
    ],
    validateAccount: validate
  })
  return { registry, controller, member, validate }
}

describe('GitHub participant settings', () => {
  it('keeps an attested member job from receiving local CLI owner powers', async () => {
    const { controller, registry, member } = fixture()
    const identity = { repoId: 'repo', participantId: member.id, account: alice }
    await runWithGitHubExecutionIdentity(identity, async () => {
      const job = { kind: 'local-cli' } as const
      await expect(controller.setEnabled('repo', job, false)).rejects.toThrow('owner_required')
      await expect(controller.remove('repo', job, member.id)).rejects.toThrow('owner_required')
      expect(await controller.status('repo', job)).toMatchObject({
        isOwner: false,
        participantId: member.id,
        selectedAccount: alice
      })
    })
    expect(registry.isRepoEnabled('repo')).toBe(true)
  })
  it('exposes only self accounts and keeps member selection separate from shared binding', async () => {
    const { controller, registry } = fixture()
    const status = await controller.status('repo', caller)
    expect(status).toMatchObject({
      enabled: true,
      isOwner: false,
      participantName: 'Alice',
      allowedAccounts: [alice]
    })
    expect(status).not.toHaveProperty('participants')
    expect(status).not.toHaveProperty('devices')
    await controller.select('repo', caller, alice)
    expect(registry.resolveAccount('repo', 'alice-device')?.account).toEqual(alice)
    expect((await controller.status('repo', owner)).selectedAccount).toEqual(bob)
  })

  it('refuses a member granting accounts, assigning devices, removing members or disabling mode', async () => {
    const { controller, registry, member } = fixture()
    await expect(
      controller.save('repo', caller, {
        id: member.id,
        name: 'Alice',
        deviceIds: ['alice-device'],
        allowedAccounts: [bob]
      })
    ).rejects.toThrow('owner_required')
    await expect(controller.remove('repo', caller, member.id)).rejects.toThrow('owner_required')
    await expect(controller.setEnabled('repo', caller, false)).rejects.toThrow('owner_required')
    expect(registry.isRepoEnabled('repo')).toBe(true)
    expect(registry.listParticipants().find((p) => p.id === member.id)?.allowedAccounts).toEqual([
      alice
    ])
  })

  it('refuses unassigned account before credential lookup and refuses unavailable credentials before saving', async () => {
    const { controller, registry, validate } = fixture()
    await expect(controller.select('repo', caller, bob)).rejects.toThrow('account_not_allowed')
    expect(validate).not.toHaveBeenCalled()
    validate.mockResolvedValue({ ok: false, error: 'gh_bound_account_unavailable' })
    await expect(controller.select('repo', caller, alice)).rejects.toThrow('unavailable')
    expect(registry.getSelf('repo', 'alice-device').selectedAccount).toBeUndefined()
  })

  it('reports missing membership without exposing or falling back to shared account', async () => {
    const { controller } = fixture()
    const result = await controller.status('repo', { kind: 'paired-device', deviceId: 'unknown' })
    expect(result).toMatchObject({ enabled: true, isOwner: false, allowedAccounts: [] })
    expect(result.error).toBeTruthy()
    expect(result.selectedAccount).toBeUndefined()
  })

  it('lets owner administer members and returns confirmed persisted state', async () => {
    const { controller, registry, member } = fixture()
    await controller.save('repo', owner, {
      id: member.id,
      name: 'Alice renamed',
      deviceIds: ['alice-device'],
      allowedAccounts: [alice, bob]
    })
    const result = await controller.status('repo', owner)
    expect(result.participants?.find((p) => p.id === member.id)?.name).toBe('Alice renamed')
    await controller.remove('repo', owner, member.id)
    expect(registry.listParticipants()).toHaveLength(1)
  })
})
