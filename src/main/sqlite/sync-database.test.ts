import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from './sync-database'

const temporaryDirectories: string[] = []
const openDatabases: SyncDatabase.Database[] = []
const lockHolders: Worker[] = []

async function createDatabase(): Promise<SyncDatabase.Database> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-sync-database-'))
  temporaryDirectories.push(directory)
  const db = new SyncDatabase(join(directory, 'test.db'))
  openDatabases.push(db)
  db.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT); ' +
      "INSERT INTO items (id, label) VALUES ('a', 'alpha'), ('b', 'beta')"
  )
  return db
}

afterEach(async () => {
  await Promise.all(lockHolders.splice(0).map((worker) => worker.terminate()))
  for (const db of openDatabases.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('SyncDatabase statement cache', () => {
  it('reuses the same statement object for identical SQL', async () => {
    const db = await createDatabase()
    const sql = 'SELECT label FROM items WHERE id = ?'

    expect(db.prepare(sql)).toBe(db.prepare(sql))
    expect(db.prepare('SELECT id FROM items WHERE id = ?')).not.toBe(db.prepare(sql))
  })

  it('returns correct rows when a reused statement is bound to different values', async () => {
    const db = await createDatabase()
    const sql = 'SELECT label FROM items WHERE id = ?'

    expect(db.prepare(sql).get('a')).toEqual({ label: 'alpha' })
    expect(db.prepare(sql).get('b')).toEqual({ label: 'beta' })
    expect(db.prepare(sql).get('missing')).toBeUndefined()
    expect(db.prepare(sql).all('a')).toEqual([{ label: 'alpha' }])
  })

  it('bounds the cache so per-arity SQL cannot grow it without limit', async () => {
    const db = await createDatabase()
    const first = 'SELECT 0 AS n'
    const firstStatement = db.prepare(first)
    for (let index = 1; index <= 256; index += 1) {
      db.prepare(`SELECT ${index} AS n`)
    }

    expect(db.prepare(first)).not.toBe(firstStatement)
    expect(db.prepare('SELECT 256 AS n')).toBe(db.prepare('SELECT 256 AS n'))
  })

  it('drops cached statements on close', async () => {
    const db = await createDatabase()
    db.prepare('SELECT label FROM items WHERE id = ?')
    db.close()

    const cache = (db as unknown as { statementCache: Map<string, unknown> }).statementCache
    expect(cache.size).toBe(0)
  })

  it('does not serve a stale statement after DDL adds a column', async () => {
    const db = await createDatabase()
    expect(db.prepare('SELECT * FROM items WHERE id = ?').all('a')).toEqual([
      { id: 'a', label: 'alpha' }
    ])

    db.exec("ALTER TABLE items ADD COLUMN note TEXT; UPDATE items SET note = 'noted'")

    expect(db.prepare('SELECT * FROM items WHERE id = ?').all('a')).toEqual([
      { id: 'a', label: 'alpha', note: 'noted' }
    ])
    expect(db.prepare('SELECT label FROM items WHERE id = ?').all('a')).toEqual([
      { label: 'alpha' }
    ])
  })

  it('keeps a cached statement correct when another connection changes the schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-sync-database-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'shared.db')
    const writer = new SyncDatabase(path)
    const reader = new SyncDatabase(path)
    openDatabases.push(writer, reader)
    writer.exec("CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES ('a')")
    const sql = 'SELECT id FROM items ORDER BY id'
    expect(reader.prepare(sql).all()).toEqual([{ id: 'a' }])

    writer.exec("ALTER TABLE items ADD COLUMN note TEXT; INSERT INTO items VALUES ('b', 'noted')")

    expect(reader.prepare(sql).all()).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(reader.prepare('SELECT note FROM items WHERE id = ?').all('b')).toEqual([
      { note: 'noted' }
    ])
  })

  it('does not cache wildcard selects or pragma statements', async () => {
    const db = await createDatabase()

    expect(db.prepare('SELECT * FROM items')).not.toBe(db.prepare('SELECT * FROM items'))
    expect(db.prepare('PRAGMA table_info(items)')).not.toBe(db.prepare('PRAGMA table_info(items)'))
    expect(db.prepare('SELECT COUNT(*) AS n FROM items')).toBe(
      db.prepare('SELECT COUNT(*) AS n FROM items')
    )
  })

  it('keeps cached statements across transaction control and other non-DDL exec calls', async () => {
    const db = await createDatabase()
    const sql = 'SELECT label FROM items WHERE id = ?'
    const statement = db.prepare(sql)

    db.exec('BEGIN IMMEDIATE')
    db.exec("INSERT INTO items (id, label) VALUES ('c', 'gamma')")
    db.exec('COMMIT')

    expect(db.prepare(sql)).toBe(statement)
    expect(statement.get('c')).toEqual({ label: 'gamma' })
  })

  it('preserves pragma and exec behavior', async () => {
    const db = await createDatabase()

    expect(db.pragma('journal_mode', { simple: true })).toBe('delete')
    expect(db.pragma('table_info(items)')).toEqual([
      expect.objectContaining({ name: 'id' }),
      expect.objectContaining({ name: 'label' })
    ])
    expect(db.pragma('table_info(missing_table)')).toEqual([])
    expect(db.pragma('table_info(missing_table)', { simple: true })).toBeUndefined()
  })

  it('rejects a missing file when fileMustExist is set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-sync-database-'))
    temporaryDirectories.push(directory)

    expect(() => new SyncDatabase(join(directory, 'absent.db'), { fileMustExist: true })).toThrow(
      /does not exist/
    )
  })
})

// Why (#15036): the OpenCode readers opened read-only with no busy timeout, so a
// contended DB failed in ~1 ms and emptied the whole panel. These pin that the
// wrapper really forwards `timeout` into sqlite3_busy_timeout.
describe('SyncDatabase read-only opens under contention', () => {
  // The lock holder must live on another thread: sqlite3_busy_timeout sleeps
  // synchronously, so a same-thread timer could never fire to release it.
  const WRITER_SOURCE = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(workerData.path)
    db.exec('PRAGMA journal_mode=DELETE')
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES ('a')")
    db.exec('BEGIN EXCLUSIVE')
    db.exec("INSERT INTO items VALUES ('b')")
    parentPort.postMessage('locked')
    setTimeout(() => {
      db.exec('COMMIT')
      db.close()
      parentPort.postMessage('released')
    }, workerData.holdMs)
  `

  async function contendedDatabase(holdMs: number): Promise<{ path: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-sync-database-busy-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'contended.db')
    const worker = new Worker(WRITER_SOURCE, { eval: true, workerData: { path, holdMs } })
    lockHolders.push(worker)
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve())
      worker.once('error', reject)
    })
    return { path }
  }

  it('fails immediately with SQLITE_BUSY when no timeout is given', async () => {
    const contended = await contendedDatabase(10_000)
    const startedAt = Date.now()

    let thrown: unknown
    try {
      new SyncDatabase(contended.path, { readonly: true }).prepare('SELECT id FROM items').all()
    } catch (error) {
      thrown = error
    }

    expect((thrown as { errcode?: number }).errcode).toBe(5)
    expect((thrown as Error).message).toContain('database is locked')
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('waits for the configured busy timeout before giving up', async () => {
    const contended = await contendedDatabase(10_000)
    const startedAt = Date.now()

    expect(() =>
      new SyncDatabase(contended.path, { readonly: true, timeout: 400 })
        .prepare('SELECT id FROM items')
        .all()
    ).toThrow(/database is locked/)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350)
  })

  it('succeeds once the writer commits inside the busy timeout', async () => {
    const contended = await contendedDatabase(150)

    const reader = new SyncDatabase(contended.path, { readonly: true, timeout: 5_000 })
    openDatabases.push(reader)

    expect(reader.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([
      { id: 'a' },
      { id: 'b' }
    ])
  })
})
