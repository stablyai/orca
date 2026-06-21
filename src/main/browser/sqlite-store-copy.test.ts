import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
    const { tempDir, tempDbPath, cleanup } = copyChromiumStoreToTemp(db)
    expect(readFileSync(tempDbPath, 'utf8')).toBe('DBDATA')
    expect(readFileSync(`${tempDbPath}-wal`, 'utf8')).toBe('WAL')
    cleanup()
    expect(existsSync(tempDir)).toBe(false)
  })
})
