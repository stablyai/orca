import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../loading-store/profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('worker authority close admission', () => {
  it('refuses new commands while its existing backup drains', async () => {
    const { authority, directory, readState } = await createWorkerMaintenanceFixture()
    const before = readState()
    const release = maintenanceBarrier()
    vi.spyOn(ProfileStateBackupRotation.prototype, 'drain').mockReturnValueOnce(release.promise)
    const closeWriter = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'close')

    const closing = authority.close()
    expect(authority.close()).toBe(closing)
    expect(closeWriter).toHaveBeenCalledOnce()
    expect(() => authority.assertWritable()).toThrow('closing')
    await expect(
      authority.writeSerializedDomains([{ domain: 'settings', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-closed', outcome: 'known-failure' })
    await expect(
      authority.writeJsonExport(join(directory, 'late-export.json'))
    ).rejects.toMatchObject({
      code: 'profile-state-writer-closed'
    })

    release.resolve()
    await closing
    expect(closeWriter).toHaveBeenCalledOnce()
    expect(readState()).toEqual(before)
  })

  it('finishes an accepted write before releasing its database', async () => {
    const { authority, readState } = await createWorkerMaintenanceFixture()
    const accepted = authority.writeSerializedDomains([
      { domain: 'ui', payload: '{"accepted":true}' }
    ])
    const closing = authority.close()
    await expect(accepted).resolves.toBeUndefined()
    await closing
    expect(readState().ui).toEqual({ accepted: true })
    await expect(authority.assertCurrentRevision()).rejects.toMatchObject({
      code: 'profile-state-writer-closed'
    })
  })
})
