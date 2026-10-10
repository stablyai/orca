import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const recovery = {
  targetId: 'async-target',
  clientInstanceId: 'first-owner',
  serverBuildId: 'build',
  clientGeneration: 1,
  ownerGeneration: 1,
  ownerLease: 'owner-lease'
}

describe('reserved SSH persistence', () => {
  it('reserves consumer replacement before mutation and durably writes both exact owners', async () => {
    const { store, authority } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const older = store.flushPendingOrThrowAsync()
    await gate.started.promise
    const first = store.upsertSshPtyConsumerRecovery(recovery)
    const second = store.upsertSshPtyConsumerRecovery({
      ...recovery,
      clientInstanceId: 'next-owner'
    })
    expect(store.getSshPtyConsumerRecovery(recovery.targetId)).toBeNull()
    gate.finish.resolve()
    await Promise.all([older, first, second])
    const ownerWrites = authority.captures
      .flat()
      .filter(({ domain }) => domain === 'sshPtyConsumerRecoveries')
    expect(ownerWrites).toHaveLength(2)
    expect(ownerWrites[0]?.payload).toContain('first-owner')
    expect(ownerWrites[1]?.payload).toContain('next-owner')
  })

  it('does not detach a newer replacement lease while waiting for the writer', async () => {
    const { store, authority, readState } = await fixture()
    const lease = { targetId: recovery.targetId, ptyId: 'relay-pty', state: 'attached' as const }
    store.upsertSshRemotePtyLease(lease)
    await store.flushPendingOrThrowAsync()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const older = store.flushPendingOrThrowAsync()
    await gate.started.promise
    const detach = store.markSshRemotePtyLeasesAsync(recovery.targetId, 'detached')
    expect(store.getSshRemotePtyLeases(recovery.targetId)[0]?.state).toBe('attached')
    store.upsertSshRemotePtyLease({ ...lease, worktreeId: 'new-worktree' })
    gate.finish.resolve()
    await Promise.all([older, detach])
    expect(readState().sshRemotePtyLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ptyId: 'relay-pty',
          worktreeId: 'new-worktree',
          state: 'attached'
        })
      ])
    )
  })

  it('does not acknowledge a failed attachment retry before its lease reaches disk', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.upsertSshRemotePtyLease({
      targetId: recovery.targetId,
      ptyId: 'relay-pty',
      state: 'expired'
    })
    await store.flushPendingOrThrowAsync()
    const gate = authority.pause()
    const attachment = expect(
      store.markSshRemotePtyLeasesAttachedAsync(recovery.targetId, ['relay-pty'])
    ).rejects.toThrow('disk refused')
    await gate.started.promise
    gate.finish.reject(new Error('disk refused'))
    await attachment
    expect(readState().sshRemotePtyLeases[0].state).toBe('expired')
    await store.markSshRemotePtyLeasesAttachedAsync(recovery.targetId, ['relay-pty'])
    expect(readState().sshRemotePtyLeases[0].state).toBe('attached')
  })
})
