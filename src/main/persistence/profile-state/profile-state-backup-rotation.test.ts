import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath,
  profileStateDatabaseBackups
} from './profile-state-backup-path'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import * as backupExecution from './profile-state-backup-worker'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual }
})

const directories: string[] = []
const rotations: ProfileStateBackupRotation[] = []
const databases: ReturnType<typeof openProfileStateDatabase>[] = []
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  vi.spyOn(backupExecution, 'runProfileStateBackup')
})

afterEach(async () => {
  for (const rotation of rotations.splice(0)) {
    rotation.stop()
    await rotation.drain()
  }
  for (const opened of databases.splice(0)) {
    opened.db.close()
  }
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sqlite-backup-'))
  directories.push(directory)
  const databasePath = join(directory, 'profile-state.db')
  const opened = openProfileStateDatabase(databasePath, 'backup-profile')
  databases.push(opened)
  const clock = { now: Date.now() }
  const rotation = createRotation(databasePath, () => clock.now)
  const write = (generation: number) => {
    importProfileStateJson(opened.db, JSON.stringify({ settings: { generation } }))
  }
  write(1)
  return { directory, databasePath, opened, rotation, write, clock }
}

function createRotation(databasePath: string, now: () => number = Date.now) {
  const rotation = new ProfileStateBackupRotation(databasePath, 'backup-profile', now)
  rotations.push(rotation)
  return rotation
}

function readBackup(path: string) {
  const opened = openProfileStateDatabaseReadOnly(path, 'backup-profile')
  try {
    return JSON.parse(readProfileStateSnapshot(opened.db).json)
  } finally {
    opened.db.close()
  }
}

describe('automatic SQLite recovery generations', () => {
  it('copies committed WAL state once, without a live JSON writer or snapshot sidecars', async () => {
    const { directory, databasePath, rotation, write } = fixture()
    write(2)
    rotation.schedule()
    rotation.schedule()
    await rotation.drain()
    const backups = profileStateDatabaseBackups(databasePath)
    expect(backups).toHaveLength(1)
    expect(readBackup(backups[0].path)).toEqual({ settings: { generation: 2 } })
    expect(existsSync(join(directory, 'orca-data.json'))).toBe(false)
    expect(readdirSync(directory).filter((name) => name.includes('.backup.'))).toEqual([
      backups[0].path.slice(directory.length + 1)
    ])
  })

  it('keeps five hourly generations and remembers cadence across reopen', async () => {
    const { databasePath, rotation, write, clock } = fixture()
    const beginning = Date.now()
    clock.now = beginning
    for (let generation = 1; generation <= 7; generation++) {
      clock.now = beginning + (generation - 1) * HOUR
      write(generation)
      rotation.schedule()
      await rotation.drain()
    }
    const backups = profileStateDatabaseBackups(databasePath)
    expect(backups).toHaveLength(5)
    expect(backups.map(({ path }) => readBackup(path).settings.generation)).toEqual([7, 6, 5, 4, 3])
    const reopened = createRotation(databasePath, () => clock.now)
    reopened.schedule()
    await reopened.drain()
    expect(profileStateDatabaseBackups(databasePath)).toEqual(backups)
    clock.now = beginning + 7 * HOUR - 1
    reopened.schedule()
    await reopened.drain()
    expect(profileStateDatabaseBackups(databasePath)).toEqual(backups)
    clock.now = beginning + 7 * HOUR
    write(8)
    reopened.schedule()
    await reopened.drain()
    expect(
      profileStateDatabaseBackups(databasePath).map(
        ({ path }) => readBackup(path).settings.generation
      )
    ).toEqual([8, 7, 6, 5, 4])
  })

  it('preserves all earlier backups on failure and retries without rejecting a committed write', async () => {
    const { databasePath, rotation, opened, write, clock } = fixture()
    const beginning = Date.now()
    clock.now = beginning
    rotation.schedule()
    await rotation.drain()
    const retained = profileStateDatabaseBackups(databasePath)
    const snapshot = vi
      .spyOn(backupExecution, 'runProfileStateBackup')
      .mockClear()
      .mockRejectedValueOnce(new Error('disk full'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    clock.now = beginning + HOUR
    write(2)
    rotation.schedule()
    await expect(rotation.drain()).resolves.toBeUndefined()
    expect(JSON.parse(readProfileStateSnapshot(opened.db).json).settings.generation).toBe(2)
    expect(profileStateDatabaseBackups(databasePath)).toEqual(retained)
    expect(log).toHaveBeenCalledOnce()
    rotation.schedule()
    await rotation.drain()
    expect(snapshot).toHaveBeenCalledOnce()
    clock.now = beginning + HOUR + 60_000
    rotation.schedule()
    await rotation.drain()
    expect(profileStateDatabaseBackups(databasePath)).toHaveLength(2)
  })

  it('does not prune previous generations when the new copy fails strict validation', async () => {
    const { databasePath, rotation, clock } = fixture()
    const beginning = Date.now()
    clock.now = beginning
    rotation.schedule()
    await rotation.drain()
    const retained = profileStateDatabaseBackups(databasePath)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(backupExecution, 'runProfileStateBackup')
      .mockClear()
      .mockRejectedValueOnce(new Error('staged validation failed'))
    clock.now = beginning + HOUR
    rotation.schedule()
    await rotation.drain()
    expect(profileStateDatabaseBackups(databasePath)).toEqual(retained)
  })

  it('cancels a queued backup before opening a source after Store close', async () => {
    const { databasePath, rotation } = fixture()
    rotation.schedule()
    expect(() => rotation.assertIdle()).toThrow('Flush pending')
    rotation.stop()
    expect(() => rotation.assertIdle()).toThrow('Flush pending')
    await rotation.drain()
    expect(() => rotation.assertIdle()).not.toThrow()
    expect(profileStateDatabaseBackups(databasePath)).toEqual([])
  })

  it('blocks synchronous quarantine until retention pruning finishes', async () => {
    const { databasePath, rotation, clock } = fixture()
    for (let generation = 0; generation < 5; generation++) {
      rotation.schedule()
      await rotation.drain()
      clock.now += HOUR
    }
    const oldest = profileStateDatabaseBackups(databasePath)[4].path
    const remove = fsPromises.rm
    let begin: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === oldest) {
        begin()
        await gate
      }
      await remove(path, options)
    })
    rotation.schedule()
    try {
      await started
      rotation.stop()
      expect(profileStateDatabaseBackups(databasePath)).toHaveLength(6)
      expect(() => rotation.assertIdle()).toThrow('Flush pending')
    } finally {
      release()
      await rotation.drain()
    }
    expect(() => rotation.assertIdle()).not.toThrow()
    expect(profileStateDatabaseBackups(databasePath)).toHaveLength(5)
  })

  it('owns an in-flight source until completion and blocks synchronous quarantine', async () => {
    const { databasePath, rotation, opened } = fixture()
    const realSnapshot = backupExecution.runProfileStateBackup
    let begin: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(backupExecution, 'runProfileStateBackup').mockImplementationOnce(async (job) => {
      begin()
      await gate
      await realSnapshot(job)
    })
    rotation.schedule()
    await started
    rotation.stop()
    opened.db.close()
    databases.splice(databases.indexOf(opened), 1)
    expect(() => rotation.assertIdle()).toThrow('Flush pending')
    release()
    await rotation.drain()
    expect(() => rotation.assertIdle()).not.toThrow()
    expect(readBackup(profileStateDatabaseBackups(databasePath)[0].path)).toEqual({
      settings: { generation: 1 }
    })
  })

  it('does not treat a reserved-name directory as a recent successful backup', async () => {
    const { databasePath, rotation } = fixture()
    const invalid = profileStateDatabaseBackupPath(
      databasePath,
      createProfileStateDatabaseBackupId()
    )
    mkdirSync(invalid)
    rotation.schedule()
    await rotation.drain()
    expect(profileStateDatabaseBackups(databasePath)).toHaveLength(2)
    expect(existsSync(invalid)).toBe(true)
  })

  it('preserves a backup with sidecars without counting it toward cadence or retention', async () => {
    const { databasePath, rotation, clock } = fixture()
    rotation.schedule()
    await rotation.drain()
    const original = profileStateDatabaseBackups(databasePath)[0].path
    writeFileSync(`${original}-journal`, 'external unfinished write')
    const reopened = createRotation(databasePath, () => clock.now)
    for (let generation = 0; generation < 6; generation++) {
      reopened.schedule()
      await reopened.drain()
      clock.now += HOUR
    }
    expect(existsSync(original)).toBe(true)
    expect(existsSync(`${original}-journal`)).toBe(true)
    expect(profileStateDatabaseBackups(databasePath)).toHaveLength(6)
  })
})
