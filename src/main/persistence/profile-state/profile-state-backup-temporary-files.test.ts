import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as identity from './profile-state-access-identity'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import {
  profileStateBackupTemporaryPath,
  removeAbandonedProfileStateBackupFiles
} from './profile-state-backup-temporary-files'

vi.mock('./profile-state-access-identity', () => ({
  profileStateAccessBootIdentity: () => 'test-boot'
}))
vi.mock('./profile-state-access-owner', () => ({
  profileStateAccessPidNamespace: () => 'test-namespace'
}))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('abandoned profile database backups', () => {
  it('does not infer ownership when kernel identity is unavailable', async () => {
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue(null)
    const probe = vi.spyOn(process, 'kill')
    await removeAbandonedProfileStateBackupFiles('/missing/profile-state.db', Date.now())
    expect(probe).not.toHaveBeenCalled()
    expect(profileStateBackupTemporaryPath('/profile/backup.db')).not.toContain('.owner-')
  })

  it('removes only old temporary files whose owner is proven exited', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-backup-orphans-'))
    roots.push(root)
    const databasePath = join(root, 'profile-state.db')
    const backup = profileStateDatabaseBackupPath(
      databasePath,
      createProfileStateDatabaseBackupId()
    )
    const now = Date.now()
    const old = new Date(now - 2 * 60 * 60_000)
    const temporary = profileStateBackupTemporaryPath(backup)
    const orphan = temporary.replace(`.${process.pid}.`, '.12345.')
    const live = temporary.replace(`.${process.pid}.`, '.12346.')
    const unknown = temporary.replace(`.${process.pid}.`, '.12347.')
    const recent = profileStateBackupTemporaryPath(backup).replace(`.${process.pid}.`, '.12345.')
    const remote = orphan.replace(/owner-[a-f0-9]{64}/, `owner-${'0'.repeat(64)}`)
    const legacy = `${backup}.12345.${now}.ab12.tmp`
    const unrelated = `${databasePath}.unrelated.tmp`
    for (const path of [
      backup,
      orphan,
      `${orphan}-wal`,
      `${orphan}-shm`,
      `${orphan}-journal`,
      live,
      unknown,
      recent,
      remote,
      legacy,
      unrelated
    ]) {
      writeFileSync(path, 'retained')
      if (path !== recent) {
        utimesSync(path, old, old)
      }
    }
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 12345) {
        throw Object.assign(new Error('exited'), { code: 'ESRCH' })
      }
      if (pid === 12347) {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      }
      return true
    })
    await removeAbandonedProfileStateBackupFiles(databasePath, now)
    expect(readdirSync(root).sort()).toEqual(
      [backup, live, unknown, recent, remote, legacy, unrelated]
        .map((path) => basename(path))
        .sort()
    )
  })
})
