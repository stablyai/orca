import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
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
import * as durableFileWrite from '../../durable-file-write'
import * as fsPromises from 'node:fs/promises'

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
    expect(readFileSync(databasePath)).toEqual(sourceFile)
    importProfileStateJson(db, JSON.stringify({ settings: { theme: 'dark' } }))
    expect(readSnapshot(targetPath)).toBe(originalJson)
    expectNoTemporaryFiles(directory)
  })

  it('never removes an existing staging file when exclusive creation fails', async () => {
    const { db, databasePath, targetPath, originalJson } = fixture()
    await expect(
      writeProfileStateDatabaseSnapshotAsync(db, targetPath, { temporaryPath: databasePath })
    ).rejects.toThrow()
    expect(existsSync(databasePath)).toBe(true)
    expect(exportProfileStateJson(db)).toBe(originalJson)
    expect(existsSync(targetPath)).toBe(false)
  })

  // Node's incremental backup callback is not part of Bun's worker snapshot contract.
  it.skipIf(!!process.versions.bun).each(['same connection', 'another connection'] as const)(
    'keeps a consistent complete revision while writes occur from %s',
    async (connection) => {
      const { directory, databasePath, db, targetPath } = fixture()
      const writer =
        connection === 'same connection'
          ? db
          : openProfileStateDatabase(databasePath, 'profile-a').db
      if (writer !== db) {
        databases.push(writer)
      }
      const padding = 'x'.repeat(256_000)
      importProfileStateJson(
        db,
        JSON.stringify({ settings: { value: 1 }, ui: { value: 1 }, padding })
      )
      const nextJson = JSON.stringify({ settings: { value: 2 }, ui: { value: 2 }, padding })
      const nativeBackup = db.backup.bind(db)
      let wroteDuringBackup = false
      vi.spyOn(db, 'backup').mockImplementation((path) =>
        nativeBackup(path, {
          rate: 1,
          progress: ({ remainingPages }) => {
            if (remainingPages > 0 && !wroteDuringBackup) {
              wroteDuringBackup = true
              importProfileStateJson(writer, nextJson)
            }
          }
        })
      )

      await writeProfileStateDatabaseSnapshotAsync(db, targetPath)

      expect(wroteDuringBackup).toBe(true)
      expect(readSnapshot(targetPath)).toBe(nextJson)
      expect(exportProfileStateJson(db)).toBe(nextJson)
      expectNoTemporaryFiles(directory)
    }
  )

  it('preserves the previous destination and removes staging after native backup fails', async () => {
    const { directory, db, targetPath, originalJson } = fixture()
    await writeProfileStateDatabaseSnapshotAsync(db, targetPath)
    const previous = readFileSync(targetPath)
    vi.spyOn(db, 'backup').mockImplementation(async (path) => {
      writeFileSync(path, 'incomplete backup')
      writeFileSync(`${path}-journal`, 'incomplete journal')
      throw new Error('injected native backup failure')
    })

    await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
      'injected native backup failure'
    )

    expect(readFileSync(targetPath)).toEqual(previous)
    expect(exportProfileStateJson(db)).toBe(originalJson)
    expectNoTemporaryFiles(directory)
  })

  it('validates staged content before replacing the previous destination', async () => {
    const { directory, db, targetPath } = fixture()
    writeFileSync(targetPath, 'previous recovery artifact')

    await expect(
      writeProfileStateDatabaseSnapshotAsync(db, targetPath, {
        validateStagedSnapshot: () => {
          throw new Error('staged validation failed')
        }
      })
    ).rejects.toThrow('staged validation failed')

    expect(readFileSync(targetPath, 'utf8')).toBe('previous recovery artifact')
    expectNoTemporaryFiles(directory)
  })

  it('preserves the previous destination when publication fails', async () => {
    const { directory, db, targetPath } = fixture()
    await writeProfileStateDatabaseSnapshotAsync(db, targetPath)
    const previous = readFileSync(targetPath)
    importProfileStateJson(db, JSON.stringify({ settings: { theme: 'dark' } }))
    vi.spyOn(durableFileWrite, 'renameDurable').mockRejectedValue(
      new Error('injected rename failure')
    )

    await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
      'injected rename failure'
    )

    expect(readFileSync(targetPath)).toEqual(previous)
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

    expect(readFileSync(targetPath)).toEqual(previous)
    expect(exportProfileStateJson(db)).toBe(originalJson)
    expectNoTemporaryFiles(directory)
  })

  it('checks again if a transaction starts while the backup is staging', async () => {
    const { directory, db, targetPath } = fixture()
    const nativeBackup = db.backup.bind(db)
    vi.spyOn(db, 'backup').mockImplementation((path) => {
      db.exec('BEGIN IMMEDIATE')
      return nativeBackup(path)
    })
    try {
      await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
        'idle database connection'
      )
    } finally {
      db.exec('ROLLBACK')
    }
    expect(existsSync(targetPath)).toBe(false)
    expectNoTemporaryFiles(directory)
  })

  it('leaves the previous destination intact when the staged file cannot be fsynced', async () => {
    const { directory, db, targetPath } = fixture()
    writeFileSync(targetPath, 'previous recovery artifact')
    const nativeOpen = fsPromises.open
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const file = await nativeOpen(...args)
      if (args[1] === 'r+') {
        vi.spyOn(file, 'sync').mockRejectedValue(new Error('injected fsync failure'))
      }
      return file
    })

    await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
      'injected fsync failure'
    )

    expect(readFileSync(targetPath, 'utf8')).toBe('previous recovery artifact')
    expectNoTemporaryFiles(directory)
  })

  it.skipIf(!!process.versions.bun)(
    'fails clearly when native backup is unsupported without replacing the destination',
    async () => {
      const { directory, db, targetPath } = fixture()
      writeFileSync(targetPath, 'previous recovery artifact')
      const getBuiltinModule = process.getBuiltinModule.bind(process)
      vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) =>
        id === 'node:sqlite' ? {} : getBuiltinModule(id)
      )

      await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
        'Asynchronous SQLite backup is unavailable'
      )

      expect(readFileSync(targetPath, 'utf8')).toBe('previous recovery artifact')
      expectNoTemporaryFiles(directory)
    }
  )

  it.each(['', 'invalid\0path'])('rejects the invalid target %j', async (path) => {
    const { db } = fixture()
    await expect(writeProfileStateDatabaseSnapshotAsync(db, path)).rejects.toThrow(
      'snapshot path is invalid'
    )
  })

  it.each(['', '-wal', '-shm', '-journal'])(
    'refuses to replace the source database%s',
    async (suffix) => {
      const { databasePath, db, originalJson } = fixture()
      await expect(
        writeProfileStateDatabaseSnapshotAsync(db, `${databasePath}${suffix}`)
      ).rejects.toThrow('cannot replace a source database')
      expect(exportProfileStateJson(db)).toBe(originalJson)
    }
  )

  it('rejects a source database reached through a directory alias', async () => {
    const { directory, db, originalJson } = fixture()
    const alias = join(directory, 'alias')
    symlinkSync(directory, alias, 'junction')
    await expect(
      writeProfileStateDatabaseSnapshotAsync(db, join(alias, 'profile-state.db'))
    ).rejects.toThrow('cannot replace a source database')
    expect(exportProfileStateJson(db)).toBe(originalJson)
  })

  it.for(['', '-WAL', '-SHM', '-JOURNAL'])(
    'refuses source database%s case aliases on case-insensitive filesystems',
    async (suffix, { skip }) => {
      const { directory, db, originalJson } = fixture()
      const alias = join(directory, 'PROFILE-STATE.DB')
      if (!existsSync(alias)) {
        skip()
        return
      }
      await expect(writeProfileStateDatabaseSnapshotAsync(db, `${alias}${suffix}`)).rejects.toThrow(
        'cannot replace a source database'
      )
      expect(exportProfileStateJson(db)).toBe(originalJson)
    }
  )

  it.each(['-wal', '-shm', '-journal'])(
    'preserves a destination with an existing %s sidecar',
    async (suffix) => {
      const { directory, db, targetPath } = fixture()
      writeFileSync(targetPath, 'previous recovery artifact')
      writeFileSync(`${targetPath}${suffix}`, 'retained SQLite sidecar')

      await expect(writeProfileStateDatabaseSnapshotAsync(db, targetPath)).rejects.toThrow(
        'destination has SQLite sidecars'
      )

      expect(readFileSync(targetPath, 'utf8')).toBe('previous recovery artifact')
      expect(readFileSync(`${targetPath}${suffix}`, 'utf8')).toBe('retained SQLite sidecar')
      expectNoTemporaryFiles(directory)
    }
  )
})
