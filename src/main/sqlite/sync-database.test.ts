import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from './sync-database'

const temporaryDirectories: string[] = []
const openDatabases: SyncDatabase.Database[] = []

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
