import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase, { isSqliteAvailable } from './sync-database'

const directories: string[] = []
const databases: SyncDatabase[] = []

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sqlite-runtime-'))
  directories.push(directory)
  return directory
}

function open(path: string): SyncDatabase {
  const db = new SyncDatabase(path)
  databases.push(db)
  return db
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // A close-contract test already released this connection.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SQLite runtime contract', () => {
  it('restarts an interrupted cached iterator without skipping its failed row', () => {
    const db = open(':memory:')
    db.exec('CREATE TABLE rows(value INTEGER); INSERT INTO rows VALUES(1),(2),(3)')
    const statement = db.prepare('SELECT value FROM rows ORDER BY value')
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => {
        for (const row of statement.iterate()) {
          expect(row.value).toBe(1)
          throw new Error('invalid row')
        }
      }).toThrow('invalid row')
    }
    expect([...statement.iterate()]).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }])
    db.exec('DROP TABLE rows')
  })

  it('admits the actual runtime driver', () => {
    expect(isSqliteAvailable()).toBe(true)
  })

  it('enforces foreign keys by default', () => {
    const db = open(':memory:')
    db.exec(
      'CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id))'
    )
    expect(() => db.prepare('INSERT INTO children VALUES(?)').run(1)).toThrow()
    expect(db.prepare('SELECT * FROM children').all()).toEqual([])
    db.prepare('INSERT INTO parents VALUES(?)').run(1)
    expect(db.prepare('INSERT INTO children VALUES(?)').run(1).changes).toBe(1)
    expect(() => db.prepare('DELETE FROM parents WHERE id = ?').run(1)).toThrow()
  })

  it('returns safe integers as numbers without changing other SQLite values', () => {
    const db = open(':memory:')
    const row = db
      .prepare('SELECT ? AS integer, ? AS real, ? AS text, ? AS blob, ? AS empty')
      .get(Number.MAX_SAFE_INTEGER, 1.25, 'héllo', Buffer.from([0, 255, 17]), null)
    expect(row).toEqual({
      integer: Number.MAX_SAFE_INTEGER,
      real: 1.25,
      text: 'héllo',
      blob: expect.any(Uint8Array),
      empty: null
    })
    expect(row?.blob).toEqual(new Uint8Array([0, 255, 17]))
  })

  it('preserves 64-bit integers and rejects rounding in every reader by default', () => {
    const db = open(':memory:')
    const statement = db.prepare('SELECT ? AS integer')
    for (const value of [
      -(1n << 63n),
      -(1n << 63n) + 1n,
      -(1n << 53n),
      1n << 53n,
      (1n << 53n) + 1n,
      (1n << 63n) - 1n
    ]) {
      expect(() => statement.get(value)).toThrow(RangeError)
      expect(() => statement.all(value)).toThrow(RangeError)
      expect(() => [...statement.iterate(value)]).toThrow(RangeError)
      statement.setReadBigInts(true)
      expect(statement.get(value)).toEqual({ integer: value })
      expect(statement.all(value)).toEqual([{ integer: value }])
      expect([...statement.iterate(value)]).toEqual([{ integer: value }])
      statement.setReadBigInts(false)
    }
  })

  it('distinguishes large REAL values from INTEGER values in the same column', () => {
    const db = open(':memory:')
    db.exec('CREATE TABLE values_by_type(value); INSERT INTO values_by_type VALUES(1)')
    const statement = db.prepare('SELECT value FROM values_by_type')
    for (const readBigInts of [false, true, false]) {
      statement.setReadBigInts(readBigInts)
      db.exec('DELETE FROM values_by_type; INSERT INTO values_by_type VALUES(9007199254740991)')
      const safe = readBigInts ? 9007199254740991n : Number.MAX_SAFE_INTEGER
      expect(statement.get()).toEqual({ value: safe })
      db.exec(
        'DELETE FROM values_by_type; INSERT INTO values_by_type VALUES(CAST(-9223372036854775808 AS REAL))'
      )
      const real = { value: Number(-(1n << 63n)) }
      expect(statement.get()).toEqual(real)
      expect(statement.all()).toEqual([real])
      expect([...statement.iterate()]).toEqual([real])
      db.exec('DELETE FROM values_by_type; INSERT INTO values_by_type VALUES(-9223372036854775808)')
      if (readBigInts) {
        expect(statement.get()).toEqual({ value: -(1n << 63n) })
      } else {
        expect(() => statement.get()).toThrow(RangeError)
        expect(() => statement.all()).toThrow(RangeError)
        expect(() => [...statement.iterate()]).toThrow(RangeError)
      }
    }
  })

  it('rejects integers outside SQLite range before changing rows', () => {
    const db = open(':memory:')
    db.exec('CREATE TABLE items(value INTEGER)')
    const insert = db.prepare('INSERT INTO items VALUES(?)')
    for (const value of [-(1n << 63n) - 1n, 1n << 63n]) {
      expect(() => insert.run(value)).toThrow()
    }
    expect(db.prepare('SELECT count(*) AS count FROM items').get()).toEqual({ count: 0 })
  })

  it('clears old bindings and binds omitted positional values as null', () => {
    const db = open(':memory:')
    const statement = db.prepare('SELECT ? AS first, ? AS second')
    expect(statement.get('old', 'secret')).toEqual({ first: 'old', second: 'secret' })
    expect(statement.get('new')).toEqual({ first: 'new', second: null })
    expect(statement.get()).toEqual({ first: null, second: null })
    expect(statement.all()).toEqual([{ first: null, second: null }])
    expect([...statement.iterate()]).toEqual([{ first: null, second: null }])
    expect(db.prepare('SELECT 1 WHERE 0').get()).toBeUndefined()
  })

  it('reports changes and explicit rowids using the requested integer mode', () => {
    const db = open(':memory:')
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)')
    const insert = db.prepare('INSERT INTO items VALUES(?, ?)')
    expect(insert.run(3, 'first')).toEqual({ changes: 1, lastInsertRowid: 3 })
    insert.setReadBigInts(true)
    expect(insert.run(9007199254740993n, 'large')).toEqual({
      changes: 1n,
      lastInsertRowid: 9007199254740993n
    })
  })

  it('preserves large write metadata without reporting a committed write as failed', () => {
    const db = open(':memory:')
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY)')
    const rowid = 9007199254740993n
    expect(db.prepare('INSERT INTO items VALUES(?)').run(rowid)).toEqual({
      changes: 1,
      lastInsertRowid: rowid
    })
    expect(db.prepare('UPDATE items SET id=id').run()).toEqual({
      changes: 1,
      lastInsertRowid: rowid
    })
    const statement = db.prepare('SELECT id FROM items')
    statement.setReadBigInts(true)
    expect(statement.all()).toEqual([{ id: rowid }])
  })

  it('rejects explicit undefined bindings before modifying rows', () => {
    const db = open(':memory:')
    db.exec('CREATE TABLE items(value TEXT)')
    const insert = db.prepare('INSERT INTO items VALUES(?)')
    expect(() => Reflect.apply(insert.run, insert, [undefined])).toThrow()
    expect(db.prepare('SELECT count(*) AS count FROM items').get()).toEqual({ count: 0 })
    const select = db.prepare('SELECT ? AS value')
    for (const method of [select.get, select.all]) {
      expect(() => Reflect.apply(method, select, [undefined])).toThrow()
    }
    expect(() => [...Reflect.apply(select.iterate, select, [undefined])]).toThrow()
  })

  it('releases statements and an unfinished iterator before filesystem retirement', () => {
    const path = join(fixture(), 'database.db')
    const db = open(path)
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1),(2)')
    db.exec("CREATE VIRTUAL TABLE search USING fts5(content); INSERT INTO search VALUES('needle')")
    const statement = db.prepare('SELECT id FROM items ORDER BY id')
    const search = db.prepare("SELECT content FROM search WHERE search MATCH 'needle'")
    expect(search.get()).toEqual({ content: 'needle' })
    const iterator = statement.iterate()
    expect(iterator.next().value).toEqual({ id: 1 })
    db.close()
    expect(() => statement.get()).toThrow()
    expect(() => search.get()).toThrow()
    renameSync(path, `${path}.retired`)
    const reopened = open(`${path}.retired`)
    reopened.exec('DROP TABLE items')
  })

  it('opens literal filenames, URL paths and Buffer paths without treating them as data', () => {
    const path = join(fixture(), "profile % # ' é.db")
    const writer = open(path)
    writer.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(9)')
    for (const input of [pathToFileURL(path), Buffer.from(path)]) {
      const reader = new SyncDatabase(input, { readonly: true, fileMustExist: true })
      databases.push(reader)
      expect(reader.prepare('SELECT id FROM items').get()).toEqual({ id: 9 })
    }
    expect(existsSync(path)).toBe(true)
  })

  it('refuses missing databases and changes through read-only connections', () => {
    const path = join(fixture(), 'database.db')
    for (const input of [path, pathToFileURL(path), Buffer.from(path)]) {
      expect(() => new SyncDatabase(input, { fileMustExist: true })).toThrow()
      expect(() => new SyncDatabase(input, { readonly: true, fileMustExist: true })).toThrow()
      expect(existsSync(path)).toBe(false)
    }
    const writer = open(path)
    writer.exec('CREATE TABLE items(id INTEGER PRIMARY KEY)')
    const reader = new SyncDatabase(path, { readonly: true, timeout: 4321 })
    databases.push(reader)
    expect(reader.pragma('busy_timeout', { simple: true })).toBe(4321)
    expect(() => reader.exec('INSERT INTO items VALUES(1)')).toThrow()
    expect(writer.pragma('busy_timeout', { simple: true })).toBe(0)
  })

  it('copies committed WAL data through a read-only source into privately precreated output', async () => {
    const directory = fixture()
    const path = join(directory, 'database.db')
    const target = join(directory, "snapshot % # '.db")
    const writer = open(path)
    writer.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)'
    )
    writer.prepare('INSERT INTO items VALUES(?, ?)').run(19, 'committed in WAL')
    expect(existsSync(`${path}-wal`)).toBe(true)
    const source = new SyncDatabase(path, { readonly: true, fileMustExist: true })
    databases.push(source)
    writeFileSync(target, '', { flag: 'wx', mode: 0o600 })
    await source.backup(target)
    const snapshot = open(target)
    expect(snapshot.prepare('SELECT id, value FROM items').get()).toEqual({
      id: 19,
      value: 'committed in WAL'
    })
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('refuses an active transaction before creating any backup destination', async () => {
    const directory = fixture()
    const db = open(join(directory, 'database.db'))
    db.exec(
      'CREATE TABLE items(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE; INSERT INTO items VALUES(1)'
    )
    const target = join(directory, 'backup.db')
    await expect(db.backup(target)).rejects.toThrow(/idle/)
    expect(existsSync(target)).toBe(false)
    db.exec('ROLLBACK')
  })
})
