import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from './profile-state-database'
import { exportProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import type Database from '../../sqlite/sync-database'
import type * as fsPromises from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual }
})

const directories: string[] = []
const databases: Database.Database[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-async-snapshot-'))
  directories.push(directory)
  const databasePath = profileStateDatabaseFile(directory)
  const { db } = openProfileStateDatabase(databasePath, 'profile-a')
  databases.push(db)
  const originalJson = JSON.stringify({ settings: { theme: 'light' } })
  importProfileStateJson(db, originalJson)
  return { directory, databasePath, db, targetPath: join(directory, 'snapshot.db'), originalJson }
}

function readSnapshot(path: string): string {
  const { db } = openProfileStateDatabaseReadOnly(path, 'profile-a')
  try {
    return exportProfileStateJson(db)
  } finally {
    db.close()
  }
}

function expectNoTemporaryFiles(directory: string): void {
  expect(readdirSync(directory).filter((name) => name.includes('.tmp'))).toEqual([])
}

describe('asynchronous profile-state database snapshots', () => {
  it('publishes a hardened self-contained snapshot including committed WAL pages', async () => {
    const { directory, databasePath, db, targetPath, originalJson } = fixture()
    expect(existsSync(`${databasePath}-wal`)).toBe(true)
    const sourceFile = readFileSync(databasePath)

    await writeProfileStateDatabaseSnapshotAsync(db, targetPath)

    expect(readSnapshot(targetPath)).toBe(originalJson)
    expect(existsSync(`${targetPath}-wal`)).toBe(false)
    expect(existsSync(`${targetPath}-shm`)).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(targetPath).mode & 0o777).toBe(0o600)
    }
    expect(exportProfileStateJson(db)).toBe(originalJson)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(readFileSync(databasePath).equals(sourceFile)).toBe(true)
    importProfileStateJson(db, JSON.stringify({ settings: { theme: 'dark' } }))
    expect(readSnapshot(targetPath)).toBe(originalJson)
    expectNoTemporaryFiles(directory)
  })

  it('rejects active transactions without publishing uncommitted state', async () => {
    const { directory, db, targetPath, originalJson } = fixture()
    await writeProfileStateDatabaseSnapshotAsync(db, targetPath)
    const previous = readFileSync(targetPath)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec("UPDATE profile_state_documents SET payload = '{}' WHERE domain = 'settings'")
      await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
        'idle database connection'
      )
    } finally {
      db.exec('ROLLBACK')
    }

    expect(readFileSync(targetPath).equals(previous)).toBe(true)
    expect(exportProfileStateJson(db)).toBe(originalJson)
    expectNoTemporaryFiles(directory)
  })

  it('rejects a source database reached through a directory alias', async () => {
    const { directory, db, originalJson } = fixture()
    const alias = join(directory, 'alias')
    symlinkSync(directory, alias, 'junction')
    await expect(
      writeProfileStateDatabaseSnapshotAsync(db, join(alias, 'profile-state.db'))
    ).rejects.toThrow('cannot replace a source database')
    expect(exportProfileStateJson(db)).toBe(originalJson)
  })
})
