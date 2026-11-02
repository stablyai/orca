import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from './sync-database'
import { isTransientSqliteContention } from './sqlite-read-failure'

// Real node:sqlite codes distinguish transient contention (5) from missing read-only WAL companions (14); they require opposite recovery.

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function contendedDatabase(): { path: string; release: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sqlite-failure-'))
  tempDirs.push(dir)
  const path = join(dir, 'contended.db')
  const writer = new SyncDatabase(path)
  writer.exec('PRAGMA journal_mode=DELETE')
  writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
  writer.exec('BEGIN EXCLUSIVE')
  writer.exec("INSERT INTO session VALUES ('a')")
  return {
    path,
    release: () => {
      writer.exec('COMMIT')
      writer.close()
    }
  }
}

describe('isTransientSqliteContention', () => {
  it('recognizes a real SQLITE_BUSY thrown by a read-only open', () => {
    const contended = contendedDatabase()
    let reader: SyncDatabase | undefined
    let thrown: unknown
    try {
      reader = new SyncDatabase(contended.path, { readonly: true, timeout: 0 })
      reader.prepare('SELECT id FROM session').all()
    } catch (error) {
      thrown = error
    } finally {
      try {
        reader?.close()
      } finally {
        contended.release()
      }
    }

    expect(thrown).toMatchObject({ errcode: 5 })
    expect(isTransientSqliteContention(thrown)).toBe(true)
  })
})
