import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import { writeProfileStateBackup } from './profile-state-backup-job'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import {
  ensureProfileStatePreMigrationBackup,
  profileStatePreMigrationBackupPath
} from './profile-state-pre-migration-backup'

const PROFILE = 'backup-profile'
const directories: string[] = []
const databases: ReturnType<typeof openProfileStateDatabase>[] = []

afterEach(() => {
  for (const opened of databases.splice(0)) {
    opened.db.close()
  }
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pre-migration-backup-'))
  directories.push(directory)
  const databasePath = join(directory, 'profile-state.db')
  const opened = openProfileStateDatabase(databasePath, PROFILE)
  databases.push(opened)
  const write = (generation: number) => {
    importProfileStateJson(opened.db, JSON.stringify({ settings: { generation } }))
  }
  write(1)
  return {
    directory,
    databasePath,
    write,
    backupPath: profileStatePreMigrationBackupPath(databasePath)
  }
}

function readGeneration(path: string): unknown {
  const opened = openProfileStateDatabaseReadOnly(path, PROFILE)
  try {
    return JSON.parse(readProfileStateSnapshot(opened.db).json).settings.generation
  } finally {
    opened.db.close()
  }
}

describe('the backup taken before the first boot-time rewrite of saved data', () => {
  it('copies the profile next to its database', async () => {
    const { directory, databasePath, backupPath } = fixture()

    await expect(
      ensureProfileStatePreMigrationBackup(databasePath, PROFILE, writeProfileStateBackup)
    ).resolves.toBe('ready')

    expect(readGeneration(backupPath)).toBe(1)
    // Self-contained: no temporary files or SQLite sidecars are left beside it.
    expect(readdirSync(directory).filter((name) => name.includes('pre-migration'))).toEqual([
      basename(backupPath)
    ])
  })

  it('keeps the first copy on later boots, so it stays the pre-migration state', async () => {
    const { databasePath, backupPath, write } = fixture()
    await ensureProfileStatePreMigrationBackup(databasePath, PROFILE, writeProfileStateBackup)
    write(2)
    const runBackup = vi.fn(writeProfileStateBackup)

    await expect(
      ensureProfileStatePreMigrationBackup(databasePath, PROFILE, runBackup)
    ).resolves.toBe('ready')

    expect(runBackup).not.toHaveBeenCalled()
    expect(readGeneration(backupPath)).toBe(1)
  })

  it('reports a failed copy so the caller does not migrate, and leaves nothing behind', async () => {
    const { directory, databasePath, backupPath } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC'
    })

    await expect(
      ensureProfileStatePreMigrationBackup(databasePath, PROFILE, () => Promise.reject(diskFull))
    ).resolves.toBe('failed')
    expect(existsSync(backupPath)).toBe(false)
    expect(readdirSync(directory).some((name) => name.includes('pre-migration'))).toBe(false)

    // A later boot with room takes the copy then.
    await expect(
      ensureProfileStatePreMigrationBackup(databasePath, PROFILE, writeProfileStateBackup)
    ).resolves.toBe('ready')
    expect(readGeneration(backupPath)).toBe(1)
  })

  it('refuses rather than replaces something else at the backup path', async () => {
    const { databasePath, backupPath } = fixture()
    mkdirSync(backupPath)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runBackup = vi.fn(writeProfileStateBackup)

    await expect(
      ensureProfileStatePreMigrationBackup(databasePath, PROFILE, runBackup)
    ).resolves.toBe('failed')
    expect(runBackup).not.toHaveBeenCalled()
  })

  it('is not one of the hourly backups, so rotation never prunes it', async () => {
    const { databasePath, backupPath, write } = fixture()
    await ensureProfileStatePreMigrationBackup(databasePath, PROFILE, writeProfileStateBackup)
    let now = Date.now()
    const rotation = new ProfileStateBackupRotation(
      databasePath,
      PROFILE,
      () => now,
      writeProfileStateBackup
    )
    for (let generation = 2; generation <= 8; generation += 1) {
      write(generation)
      now += 2 * 60 * 60 * 1000
      rotation.schedule()
      await rotation.drain()
    }
    rotation.stop()

    expect(profileStateDatabaseBackups(databasePath).map(({ path }) => path)).not.toContain(
      backupPath
    )
    expect(readGeneration(backupPath)).toBe(1)
  })
})
