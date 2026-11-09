import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sync-database'
import { KeyedJsonRowCache, parseKeyedJsonRows } from './keyed-json-row-cache'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-row-cache-'))
  directories.push(directory)
  return { path: join(directory, 'cache.db'), legacyPath: join(directory, 'cache.json') }
}

const row = (key: string, value: string) => ({ key, json: JSON.stringify(value) })
/** An older build's file: a JSON array of strings; anything else is rejected. */
const parseLegacy = (text: string): string[] | null => {
  const value: unknown = JSON.parse(text)
  return Array.isArray(value) ? value.map(String) : null
}

/** What a store restores at startup: imported legacy values, or the stored rows. */
function restore(cache: KeyedJsonRowCache): unknown {
  const loaded = cache.load(parseLegacy)
  if (loaded.kind === 'unavailable') {
    return 'unavailable'
  }
  if (loaded.kind === 'import') {
    cache.write(
      loaded.value.map((value) => row(value, value)),
      { importReceipt: loaded.receipt }
    )
    return loaded.value
  }
  return parseKeyedJsonRows(loaded.rows).map(({ value }) => value)
}

describe('keyed JSON row cache', () => {
  it('saves exactly its own rows after another connection committed in between', () => {
    const { path } = paths()
    const first = new KeyedJsonRowCache(path, { schemaVersion: 1 })
    const second = new KeyedJsonRowCache(path, { schemaVersion: 1 })
    try {
      first.write([row('a', 'a1'), row('b', 'b1')])
      second.write([row('a', 'a1'), row('b', 'b1')])
      first.write([row('a', 'a2'), row('b', 'b1')])
      second.write([row('a', 'a1'), row('b', 'b2')])

      expect(restore(new KeyedJsonRowCache(path, { schemaVersion: 1 }))).toEqual(['a1', 'b2'])
    } finally {
      first.close()
      second.close()
    }
  })

  it("imports an older build's file once, even when the same bytes are later restored", () => {
    const { path, legacyPath } = paths()
    const options = { schemaVersion: 1, holdConnection: false, legacyPath }
    writeFileSync(legacyPath, '["from file"]')
    copyFileSync(legacyPath, `${legacyPath}.copy`)

    expect(restore(new KeyedJsonRowCache(path, options))).toEqual(['from file'])
    expect(existsSync(legacyPath)).toBe(false)
    new KeyedJsonRowCache(path, options).write([row('x', 'saved later')])
    // A leftover copy (failed deletion, a backup restore) is recognised by its bytes.
    copyFileSync(`${legacyPath}.copy`, legacyPath)

    expect(restore(new KeyedJsonRowCache(path, options))).toEqual(['saved later'])
    expect(existsSync(legacyPath)).toBe(false)
    writeFileSync(legacyPath, '["rewritten by an older build"]')
    expect(restore(new KeyedJsonRowCache(path, options))).toEqual(['rewritten by an older build'])
  })

  it('recognises a file imported under the earlier length:mtime:hash receipt', () => {
    const { path, legacyPath } = paths()
    const options = { schemaVersion: 1, holdConnection: false, legacyPath }
    new KeyedJsonRowCache(path, options).write([row('x', 'saved later')], {
      importReceipt:
        '13:1700000000000:526aa8236d656e8a8b8cd78bee7a16d95e1e93e99d18a37298c506cf9c789750'
    })
    writeFileSync(legacyPath, '["from file"]')

    expect(restore(new KeyedJsonRowCache(path, options))).toEqual(['saved later'])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('keeps the stored rows when an older build file is rejected', () => {
    const { path, legacyPath } = paths()
    const options = { schemaVersion: 1, holdConnection: false, legacyPath }
    new KeyedJsonRowCache(path, options).write([row('a', 'stored')])
    writeFileSync(legacyPath, '{ not json')

    expect(restore(new KeyedJsonRowCache(path, options))).toEqual(['stored'])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves an unreadable older build file and the rows for a later start',
    () => {
      const { path, legacyPath } = paths()
      const options = { schemaVersion: 1, holdConnection: false, legacyPath }
      new KeyedJsonRowCache(path, options).write([row('a', 'stored')])
      writeFileSync(legacyPath, '["from file"]')
      chmodSync(legacyPath, 0o000)

      expect(restore(new KeyedJsonRowCache(path, options))).toBe('unavailable')
      chmodSync(legacyPath, 0o600)
      expect(restore(new KeyedJsonRowCache(path, options))).toEqual(['from file'])
    }
  )

  it('reports rows held under an exclusive lock as unavailable and keeps the older file', () => {
    const { path, legacyPath } = paths()
    const options = { schemaVersion: 1, holdConnection: false, legacyPath }
    new KeyedJsonRowCache(path, options).write([row('a', 'stored')])
    writeFileSync(legacyPath, '["from file"]')
    const locker = new SyncDatabase(path)
    locker.pragma('locking_mode = EXCLUSIVE')
    locker.exec('BEGIN EXCLUSIVE')
    try {
      expect(restore(new KeyedJsonRowCache(path, { ...options, busyTimeoutMs: 0 }))).toBe(
        'unavailable'
      )
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('rebuilds a database whose row pages are corrupt and saves again', () => {
    const { path } = paths()
    new KeyedJsonRowCache(path, { schemaVersion: 1, holdConnection: false }).write([row('a', '1')])
    const db = new SyncDatabase(path)
    const root = db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'rows'`).get()
    const pageSize = Number(db.pragma('page_size', { simple: true }))
    db.close()
    const fd = openSync(path, 'r+')
    writeSync(
      fd,
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      0,
      4,
      (Number(root?.rootpage) - 1) * pageSize
    )
    closeSync(fd)

    new KeyedJsonRowCache(path, { schemaVersion: 1, holdConnection: false }).write([row('b', '2')])
    expect(restore(new KeyedJsonRowCache(path, { schemaVersion: 1 }))).toEqual(['2'])
  })
})
