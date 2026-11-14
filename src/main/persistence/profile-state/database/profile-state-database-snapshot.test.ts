import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../documents/profile-state-documents'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import type Database from '../../../sqlite/sync-database'
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
})
