import { mkdtempSync, rmSync } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
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
})
