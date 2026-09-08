import type * as NodeFs from 'node:fs'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  removeTree,
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS
} from '../../shared/windows-transient-lock-removal'
import SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_SCHEMA_VERSION,
  openSessionSearchDatabase,
  removeSessionSearchDatabase,
  VISIBLE_MESSAGES,
  VISIBLE_SESSIONS
} from './session-search-schema'

const recordedRmSync = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      recordedRmSync(...args)
      return actual.rmSync(...args)
    }
  }
})

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
    // Why not inode: ext4 hands a freed inode straight back to the next create.
    // The planted sidecar is gone (a fresh WAL is checkpointed away on close).
    await expect(stat(`${path}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(path)).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
  })

  it('indexes only in-flight batch pointers, not every published message', async () => {
    const db = openSessionSearchDatabase(await tempDatabasePath())
    try {
      const sql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='messages_batch'")
          .get() as { sql: string }
      ).sql
      // Publish nulls batch_id, so a full index would carry one dead entry per message.
      expect(sql).toContain('WHERE batch_id IS NOT NULL')
    } finally {
      db.close()
    }
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

it('closes the SQLite handle when corrupt data fails initialization', async () => {
  const path = await tempDatabasePath()
  await writeFile(path, 'not a SQLite database')
  const close = vi.spyOn(SyncDatabase.prototype, 'close')
  try {
    expect(() => openSessionSearchDatabase(path)).toThrow()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    close.mockRestore()
  }
  removeSessionSearchDatabase(path)
  const recovered = openSessionSearchDatabase(path)
  recovered.close()
})

describe('visibility views', () => {
  it('hides a staging session, a tombstoned session and an in-flight batch', async () => {
    const db = openSessionSearchDatabase(await tempDatabasePath())
    try {
      db.exec(`INSERT INTO sessions(id,index_ready,agent,session_id,file_path,title,resume_command)
        VALUES (1,1,'claude','a','a','published',''),(2,0,'claude','b','b','staging',''),
               (3,1,'claude','c','c','tombstoned','');
        INSERT INTO search_pending_deletes(path,session_row_id) VALUES ('c',3);
        INSERT INTO search_write_batches(id,session_row_id) VALUES (7,1);
        INSERT INTO messages(id,session_row_id,batch_id,role) VALUES (1,1,NULL,'user'),(2,1,7,'user')`)
      expect(db.prepare(`SELECT title FROM ${VISIBLE_SESSIONS} ORDER BY id`).all()).toEqual([
        { title: 'published' }
      ])
      expect(db.prepare(`SELECT id FROM ${VISIBLE_MESSAGES} ORDER BY id`).all()).toEqual([
        { id: 1 }
      ])
      // Publish clears the pointer, so visibility never depends on the batch row surviving.
      db.exec(
        'UPDATE messages SET batch_id=NULL WHERE batch_id=7; DELETE FROM search_write_batches'
      )
      expect(db.prepare(`SELECT count(*) AS n FROM ${VISIBLE_MESSAGES}`).get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })
})

it("retries a Windows lock that outlives rmSync's own retries", async () => {
  const path = await tempDatabasePath()
  openSessionSearchDatabase(path).close()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  recordedRmSync.mockReset()
  const locked = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  recordedRmSync.mockImplementationOnce(() => {
    throw locked
  })
  try {
    expect(() => removeSessionSearchDatabase(path)).not.toThrow()
    expect(recordedRmSync.mock.calls.length).toBe(5)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    recordedRmSync.mockReset()
    vi.restoreAllMocks()
  }
})

it('gives Windows the shared retry options for a late handle release', async () => {
  const path = await tempDatabasePath()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  recordedRmSync.mockClear()
  try {
    removeSessionSearchDatabase(path)
    expect(recordedRmSync).toHaveBeenCalled()
    for (const [, options] of recordedRmSync.mock.calls) {
      expect(options).toMatchObject({
        maxRetries: WINDOWS_RM_MAX_RETRIES,
        retryDelay: WINDOWS_RM_RETRY_DELAY_MS
      })
    }
  } finally {
    vi.restoreAllMocks()
  }
})
