import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'
import './profile-state-database-schema'
import { importProfileStateJson } from '../documents/profile-state-documents'
import { quarantineProfileStateDatabase } from '../recovery/profile-state-database-quarantine'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-db-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('profile state database', () => {
  it('rejects a database whose profile identity does not match', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    opened.db.close()
    const before = readFileSync(dbPath)

    expect(() => openProfileStateDatabase(dbPath, 'profile-b')).toThrowError(
      expect.objectContaining({ code: 'identity-mismatch' })
    )
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('rejects malformed database bytes without replacing them', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const bytes = Buffer.from('not a sqlite database')
    writeFileSync(dbPath, bytes)

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
    expect(readFileSync(dbPath).equals(bytes)).toBe(true)
  })

  it('quarantines the database family without touching live recovery sources', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' } }))
    opened.db.close()
    writeFileSync(`${dbPath}-wal`, 'wal-preservation-sentinel')

    const sourceBytes = new Map(
      [dbPath, `${dbPath}-wal`].map((path) => [path, readFileSync(path).toString('hex')])
    )
    const result = quarantineProfileStateDatabase(
      dbPath,
      'profile-a',
      join(directory, 'quarantine'),
      'test-corruption'
    )

    expect(result.copiedFiles).toHaveLength(2)
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      profileId: 'profile-a',
      reason: 'test-corruption',
      sourceFiles: expect.arrayContaining(['', '-wal'])
    })
    expect(readFileSync(join(result.directory, 'profile-state.db')).toString('hex')).toBe(
      sourceBytes.get(dbPath)
    )
    expect(readFileSync(join(result.directory, 'profile-state.db-wal')).toString('hex')).toBe(
      sourceBytes.get(`${dbPath}-wal`)
    )
    for (const [path, bytes] of sourceBytes) {
      expect(readFileSync(path).toString('hex')).toBe(bytes)
    }
  })
})
