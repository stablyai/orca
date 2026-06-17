import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mirrorOmpPersistentSqliteFiles } from './omp-sqlite-overlay'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-omp-sqlite-overlay-'))
  tempDirs.push(dir)
  return dir
}

describe('OMP SQLite overlay persistence', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces overlay-local SQLite files with source-backed DB files', () => {
    const root = makeTempDir()
    const sourceDir = join(root, 'source-agent')
    const overlayDir = join(root, 'overlay-agent')
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'agent.db'), 'overlay main')
    writeFileSync(join(overlayDir, 'agent.db-wal'), 'overlay wal')

    const mirroredEntries = mirrorOmpPersistentSqliteFiles(sourceDir, overlayDir)

    expect(mirroredEntries).toContain('agent.db')
    expect(mirroredEntries).not.toContain('history.db')
    expect(readFileSync(join(sourceDir, 'agent.db'), 'utf8')).toBe('')
    expect(existsSync(join(sourceDir, 'agent.db-wal'))).toBe(process.platform === 'win32')

    writeFileSync(join(overlayDir, 'agent.db'), 'new credentials')

    expect(readFileSync(join(sourceDir, 'agent.db'), 'utf8')).toBe('new credentials')
    if (process.platform !== 'win32') {
      expect(lstatSync(join(overlayDir, 'agent.db')).isSymbolicLink()).toBe(true)
      expect(existsSync(join(overlayDir, 'agent.db-wal'))).toBe(false)
    }
  })

  it('keeps SQLite WAL writes source-backed through the OMP overlay path', () => {
    const root = makeTempDir()
    const sourceDir = join(root, 'source-agent')
    const overlayDir = join(root, 'overlay-agent')
    mkdirSync(overlayDir, { recursive: true })

    mirrorOmpPersistentSqliteFiles(sourceDir, overlayDir)

    const sourcePath = join(sourceDir, 'agent.db')
    const overlayPath = join(overlayDir, 'agent.db')
    const db = new DatabaseSync(overlayPath)

    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE credentials (provider TEXT PRIMARY KEY, token TEXT NOT NULL);
        INSERT INTO credentials VALUES ('anthropic', 'secret');
      `)

      expect(existsSync(`${sourcePath}-wal`)).toBe(true)
      expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0)
      expect(existsSync(`${overlayPath}-wal`)).toBe(process.platform === 'win32')

      const sourceDb = new DatabaseSync(sourcePath, { readOnly: true })
      try {
        expect(
          sourceDb.prepare('SELECT token FROM credentials WHERE provider = ?').get('anthropic')
        ).toEqual({ token: 'secret' })
      } finally {
        sourceDb.close()
      }
    } finally {
      db.close()
    }
  })
})
