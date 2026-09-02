import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_SCHEMA_VERSION,
  openSessionSearchDatabase,
  removeSessionSearchDatabase
} from './session-search-schema'

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => removeTree(root)))
  roots = []
})

async function tempDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-schema-'))
  roots.push(root)
  return join(root, 'index.sqlite')
}

function schemaVersion(db: SyncDatabase): string | undefined {
  return (
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
  )?.value
}

describe('openSessionSearchDatabase', () => {
  it('keeps a current-version index and its rows', async () => {
    const path = await tempDatabasePath()
    const first = openSessionSearchDatabase(path)
    first
      .prepare(
        "INSERT INTO search_log(ts, query, route, hits, duration_ms) VALUES ('t', 'q', 'or', 0, 1)"
      )
      .run()
    first.close()

    const second = openSessionSearchDatabase(path)
    expect(schemaVersion(second)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(second.prepare('SELECT COUNT(*) AS c FROM search_log').get()).toEqual({ c: 1 })
    second.close()
  })

  it('replaces the file on a version mismatch instead of dropping tables in place', async () => {
    const path = await tempDatabasePath()
    const stale = openSessionSearchDatabase(path)
    stale
      .prepare(
        "INSERT INTO search_log(ts, query, route, hits, duration_ms) VALUES ('t', 'q', 'or', 0, 1)"
      )
      .run()
    stale
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SESSION_SEARCH_SCHEMA_VERSION - 1))
    stale.close()
    // Why: a stale sidecar must go with the main file, or SQLite replays it into the new one.
    await writeFile(`${path}-wal`, 'stale wal bytes')
    const before = await stat(path)

    const fresh = openSessionSearchDatabase(path)
    expect(schemaVersion(fresh)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(fresh.prepare('SELECT COUNT(*) AS c FROM search_log').get()).toEqual({ c: 0 })
    fresh.close()
    const after = await stat(path)
    expect(after.ino).not.toBe(before.ino)
  })

  it('removes the database with every sidecar', async () => {
    const path = await tempDatabasePath()
    openSessionSearchDatabase(path).close()
    await writeFile(`${path}-shm`, '')
    removeSessionSearchDatabase(path)
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(stat(`${path}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
