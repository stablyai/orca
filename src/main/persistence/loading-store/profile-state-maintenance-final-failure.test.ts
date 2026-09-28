import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('quit during failed profile maintenance', () => {
  it('retries a known failed checkpoint and persists shutdown edits before closing', async () => {
    const { store, authority, readState, dataFile } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.upsertSshRemotePtyLease({ targetId: 'remote', ptyId: 'pty', state: 'attached' })
    await store.flushPendingOrThrowAsync()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const checkpoint = vi
      .spyOn(authority, 'writeCompleteSerializedDomains')
      .mockImplementationOnce(async () => {
        started.resolve()
        await release.promise
        throw new Error('SQLITE_BUSY')
      })
    store.updateSettings({ theme: 'dark' })
    const failed = expect(store.beginProfileMaintenance()).rejects.toThrow('SQLITE_BUSY')
    await started.promise
    store.markSshRemotePtyLeasesForShutdown('remote', 'detached')
    const final = store.flushFinalOrThrowAsync({ exportJsonCompatibility: true })
    const result = final.catch((error: unknown) => error)
    release.resolve()
    await failed
    await expect(result).resolves.toBeUndefined()
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      sshRemotePtyLeases: [expect.objectContaining({ state: 'detached' })]
    })
    expect(JSON.parse(readFileSync(dataFile, 'utf8'))).toEqual(readState())
  })

  it.each(['indeterminate', 'changed-source'] as const)(
    'keeps %s maintenance fenced during quit',
    async (kind) => {
      const { store, authority, readState, peer } = await createWorkerMaintenanceFixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const durable = readState()
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      const failure =
        kind === 'indeterminate'
          ? new ProfileStateWriterError('test-unknown-commit', 'commit outcome unknown', kind)
          : new Error('SQLITE_BUSY')
      const checkpoint = vi
        .spyOn(authority, 'writeCompleteSerializedDomains')
        .mockImplementationOnce(async () => {
          started.resolve()
          await release.promise
          if (kind === 'changed-source') {
            const other = peer()
            try {
              other.writeSerializedDomains([{ domain: 'peer', payload: '{"preserved":true}' }])
            } finally {
              other.close()
            }
          }
          throw failure
        })
      store.updateSettings({ theme: 'dark' })
      const failed = expect(store.beginProfileMaintenance()).rejects.toBe(failure)
      await started.promise
      const final = expect(store.flushFinalOrThrowAsync()).rejects.toBe(failure)
      release.resolve()
      await Promise.all([failed, final])
      expect(checkpoint).toHaveBeenCalledOnce()
      expect(readState()).toEqual(
        kind === 'changed-source' ? { ...durable, peer: { preserved: true } } : durable
      )
    }
  )
})
