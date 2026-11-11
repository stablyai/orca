import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { isRecord } from './profile-state-document-validation'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../loading-store/profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('worker authority close admission', () => {
  it('leaves the older-build copy alone for maintenance and brings it current on close', async () => {
    const { authority, databaseFile, profileId } = await createWorkerMaintenanceFixture()
    const v1 = '{"runtime:a":{"activeTabId":"t1"}}'
    const v2 = '{"runtime:a":{"activeTabId":"t2"}}'
    const v3 = '{"runtime:a":{"activeTabId":"t3"}}'
    // What a build without per-entry storage reads.
    const readAsOlderBuild = () => {
      const { db } = openProfileStateDatabaseReadOnly(databaseFile, profileId)
      try {
        const row: unknown = db
          .prepare(`SELECT payload FROM profile_state_documents WHERE domain = ?`)
          .get('workspaceSessionsByHostId')
        return isRecord(row) ? row.payload : undefined
      } finally {
        db.close()
      }
    }
    await authority.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v1 }])
    // Restarting the writer catches the older-build copy up to v1.
    await (await authority.pauseForMaintenance()).resume()
    await authority.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v2 }])

    const maintenance = await authority.pauseForMaintenance()
    expect(readAsOlderBuild()).toBe(v1)
    await maintenance.resume()
    await authority.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v3 }])

    await authority.close()
    expect(readAsOlderBuild()).toBe(v3)
  })

  it('reports a failed maintenance resume without accepting a changed database', async () => {
    const notify = vi.fn()
    const { authority, peer } = await createWorkerMaintenanceFixture(undefined, notify)
    const maintenance = await authority.pauseForMaintenance()
    const other = peer()
    other.writeSerializedDomains([{ domain: 'ui', payload: '{"external":true}' }])
    other.close()

    await expect(maintenance.resume()).rejects.toMatchObject({
      code: 'profile-state-revision-conflict'
    })
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'profile-state-revision-conflict' })
    )
    expect(() => authority.assertWritable()).toThrow()
  })

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
