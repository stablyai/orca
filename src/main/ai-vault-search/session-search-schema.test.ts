import type * as NodeFs from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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
  removeSessionSearchDatabase
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
    first.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
    first.close()

    const second = openSessionSearchDatabase(path)
    expect(schemaVersion(second)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(second.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 1
    })
    second.close()
  })

  it('replaces the file on a version mismatch instead of dropping tables in place', async () => {
    const path = await tempDatabasePath()
    const stale = openSessionSearchDatabase(path)
    stale.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
    stale
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SESSION_SEARCH_SCHEMA_VERSION + 1))
    stale.close()
    // Why: a stale sidecar must go with the main file, or SQLite replays it into the new one.
    await writeFile(`${path}-wal`, 'stale wal bytes')
    const before = await stat(path)

    const fresh = openSessionSearchDatabase(path)
    expect(schemaVersion(fresh)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(fresh.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 0
    })
    fresh.close()
    // Why not inode: ext4 hands a freed inode straight back to the next create.
    // The planted sidecar is gone (a fresh WAL is checkpointed away on close).
    await expect(stat(`${path}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(path)).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
  })

  it('removes the database with every sidecar', async () => {
    const path = await tempDatabasePath()
    openSessionSearchDatabase(path).close()
    await writeFile(`${path}-shm`, '')
    removeSessionSearchDatabase(path)
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(stat(`${path}${suffix}`)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })
})

it('rebuilds a file too corrupt to open instead of refusing forever', async () => {
  const path = await tempDatabasePath()
  const healthy = openSessionSearchDatabase(path)
  healthy.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
  healthy.close()
  // A torn page, not a truncation: SQLite opens the header and fails on the read.
  const bytes = await readFile(path)
  bytes.fill(0x7f, 4096, Math.min(bytes.length, 12_288))
  await writeFile(path, bytes)

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(schemaVersion(rebuilt)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(rebuilt.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 0
    })
  } finally {
    rebuilt.close()
  }
})

it('rebuilds a file that is not a database at all', async () => {
  const path = await tempDatabasePath()
  await writeFile(path, 'not a SQLite database')

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(schemaVersion(rebuilt)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
  } finally {
    rebuilt.close()
  }
})

it('gives up rather than looping when a fresh file still cannot be opened', async () => {
  const path = await tempDatabasePath()
  await writeFile(path, 'not a SQLite database')
  // Every open of this path fails, so the one permitted retry is exhausted.
  const open = vi.spyOn(SyncDatabase.prototype, 'pragma').mockImplementation(() => {
    throw Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT'
    })
  })
  try {
    expect(() => openSessionSearchDatabase(path)).toThrow(/malformed/)
  } finally {
    open.mockRestore()
  }
})

it('surfaces the unlink failure itself when a stale index cannot be removed', async () => {
  const path = await tempDatabasePath()
  const stale = openSessionSearchDatabase(path)
  stale
    .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(SESSION_SEARCH_SCHEMA_VERSION + 1))
  stale.close()
  recordedRmSync.mockReset()
  recordedRmSync.mockImplementation(() => {
    throw Object.assign(new Error('EPERM: operation not permitted, unlink'), {
      code: 'EPERM'
    })
  })
  try {
    // The stale handle is closed before the unlink, so the failure path must not
    // close it again: ERR_INVALID_STATE would bury the cause and would not be
    // classified as worth a rebuild.
    expect(() => openSessionSearchDatabase(path)).toThrow(/EPERM/)
    expect(() => openSessionSearchDatabase(path)).not.toThrow(/not open/)
  } finally {
    recordedRmSync.mockReset()
  }
})

it('creates the directory the index lives in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-mkdir-'))
  roots.push(root)
  // The real layout: `<userData>/ai-vault-search/index.sqlite`, where nothing
  // has made that folder yet. SQLite would fail with `unable to open database
  // file`, which is correctly not treated as corruption, so it never retries.
  const db = openSessionSearchDatabase(join(root, 'ai-vault-search', 'index.sqlite'))
  try {
    expect(schemaVersion(db)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
  } finally {
    db.close()
  }
})

it('rebuilds a newer index rather than reading a schema it does not know', async () => {
  const path = await tempDatabasePath()
  const newer = openSessionSearchDatabase(path)
  newer.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
  newer
    .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(SESSION_SEARCH_SCHEMA_VERSION + 1))
  newer.close()

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(schemaVersion(rebuilt)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(rebuilt.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 0
    })
  } finally {
    rebuilt.close()
  }
})

it('rebuilds when meta exists but its version row is gone', async () => {
  const path = await tempDatabasePath()
  const damaged = openSessionSearchDatabase(path)
  damaged.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
  // A meta table with no version is a damaged index, never a fresh one: seeding
  // the current version over it would keep whatever the old schema left behind.
  damaged.prepare("DELETE FROM meta WHERE key = 'schema_version'").run()
  damaged.close()

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(schemaVersion(rebuilt)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(rebuilt.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 0
    })
  } finally {
    rebuilt.close()
  }
})

it('opens with the pragmas the write path depends on', async () => {
  const db = openSessionSearchDatabase(await tempDatabasePath())
  try {
    // auto_vacuum=2 is INCREMENTAL, and only takes on an empty file: without it
    // a purge cannot hand pages back in bounded steps.
    expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(2)
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(1)
    // A WAL with no size limit never hands its space back after a large write.
    expect(Number(db.pragma('journal_size_limit', { simple: true }))).toBe(8388608)
    // Zero here turns every contended write into an immediate SQLITE_BUSY.
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(5000)
  } finally {
    db.close()
  }
})

it("walks a session's rows through an index rather than scanning the table", async () => {
  const db = openSessionSearchDatabase(await tempDatabasePath())
  try {
    // The replace delete and the orphan drain both take this path, once per file.
    const plan = (
      db
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_row_id = ? LIMIT ?')
        .all(1, 1) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' ')
    expect(plan).toContain('messages_session')
  } finally {
    db.close()
  }
})

it('keeps only the session indexes a retrieval query can seek', async () => {
  const db = openSessionSearchDatabase(await tempDatabasePath())
  try {
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort()
    // One per shape PR 4's retrieval seeks: the agent filter, the newest-first
    // order and date window, and the folder-prefix range scan. Fork folding reads
    // `content_hash` off rows it already holds, so that column is not indexed.
    expect(names).toEqual(['sessions_agent', 'sessions_cwd_key', 'sessions_updated_at'])
  } finally {
    db.close()
  }
})

it("retries a Windows lock that outlives rmSync's own retries", async () => {
  const path = await tempDatabasePath()
  openSessionSearchDatabase(path).close()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  recordedRmSync.mockReset()
  const locked = Object.assign(new Error('EPERM: operation not permitted'), {
    code: 'EPERM'
  })
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
