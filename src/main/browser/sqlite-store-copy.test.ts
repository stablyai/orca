import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyChromiumStoreToTemp } from './sqlite-store-copy'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-copy-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('copyChromiumStoreToTemp', () => {
  it('copies the db and its wal/shm sidecars, and cleanup removes the temp dir', () => {
    const db = join(dir, 'Login Data')
    writeFileSync(db, 'DBDATA')
    writeFileSync(`${db}-wal`, 'WAL')
    writeFileSync(`${db}-shm`, 'SHM')
    const { tempDir, tempDbPath, cleanup } = copyChromiumStoreToTemp(db)
    expect(readFileSync(tempDbPath, 'utf8')).toBe('DBDATA')
    expect(readFileSync(`${tempDbPath}-wal`, 'utf8')).toBe('WAL')
    expect(readFileSync(`${tempDbPath}-shm`, 'utf8')).toBe('SHM')
    cleanup()
    expect(existsSync(tempDir)).toBe(false)
  })

  it('tolerates missing sidecars without throwing', () => {
    const db = join(dir, 'Login Data')
    writeFileSync(db, 'DBDATA')
    // Neither -wal nor -shm exists; should not throw
    const { tempDbPath, cleanup } = copyChromiumStoreToTemp(db)
    expect(readFileSync(tempDbPath, 'utf8')).toBe('DBDATA')
    cleanup()
  })

  it('cleans up the temp dir when the main db copy fails (no leak)', () => {
    const nonExistent = join(dir, 'does-not-exist')
    // Snapshot before so pre-existing items with the same prefix don't falsely fail.
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith('orca-cookie-import-'))
    )
    expect(() => copyChromiumStoreToTemp(nonExistent)).toThrow()
    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith('orca-cookie-import-') && !before.has(name)
    )
    expect(after).toHaveLength(0)
  })
})
