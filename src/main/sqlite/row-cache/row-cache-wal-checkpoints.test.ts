import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sync-database'
import { KeyedJsonRowCache } from './keyed-json-row-cache'
import { RowCacheWalCheckpoints, spawnRowCacheCheckpointWorker } from './row-cache-wal-checkpoints'

class FakeWorker extends EventEmitter {
  readonly posted: { id: number; path: string }[] = []
  postMessage(message: { id: number; path: string }): void {
    this.posted.push(message)
  }
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function cachePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-row-cache-ckpt-'))
  directories.push(directory)
  return join(directory, 'cache.db')
}

describe('RowCacheWalCheckpoints', () => {
  it('hands checkpoints back to the cache connection when the worker fails', () => {
    const opens: string[] = []
    const original = SyncDatabase.prototype.exec
    vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (this: SyncDatabase, sql) {
      if (sql.includes('journal_size_limit')) {
        opens.push(sql)
      }
      return original.call(this, sql)
    })
    const worker = new FakeWorker()
    const path = cachePath()
    const cache = new KeyedJsonRowCache(path, {
      schemaVersion: 1,
      walCheckpoints: new RowCacheWalCheckpoints(() => worker)
    })

    cache.write([{ key: 'a', json: '"1"' }])
    // The commit leaves its checkpoint to the worker instead of running one itself.
    expect(opens).toHaveLength(1)
    expect(opens[0]).toContain('wal_autocheckpoint = 0')
    expect(worker.posted).toEqual([{ id: expect.any(Number), path, force: false }])

    worker.emit('error', new Error('worker crashed'))
    // A failed worker is never used again: the cache reopens with SQLite's own checkpointing.
    cache.write([{ key: 'b', json: '"2"' }])
    expect(opens).toHaveLength(2)
    expect(opens[1]).not.toContain('wal_autocheckpoint')
    expect(worker.posted).toHaveLength(1)
    expect(cache.load(() => null)).toMatchObject({ kind: 'rows', rows: [{ key: 'b' }] })
    cache.close()
  })

  it('keeps a file whose checkpoints keep failing on its own checkpointing, across reopens', () => {
    const opens: string[] = []
    const original = SyncDatabase.prototype.exec
    vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (this: SyncDatabase, sql) {
      if (sql.includes('journal_size_limit')) {
        opens.push(sql)
      }
      return original.call(this, sql)
    })
    const worker = new FakeWorker()
    const cache = new KeyedJsonRowCache(cachePath(), {
      schemaVersion: 1,
      walCheckpoints: new RowCacheWalCheckpoints(() => worker)
    })
    for (let i = 0; i < 3; i++) {
      cache.write([{ key: 'a', json: `"${i}"` }])
      worker.emit('message', { id: worker.posted.at(-1)!.id, ok: false })
    }
    expect(worker.posted).toHaveLength(3)

    for (let i = 3; i < 6; i++) {
      cache.write([{ key: 'a', json: `"${i}"` }])
    }
    expect(opens).toHaveLength(2)
    expect(opens[1]).not.toContain('wal_autocheckpoint')
    expect(worker.posted).toHaveLength(3)
    cache.close()
  })

  it('keeps a damaged file in place until a checkpoint on it, from any instance, has finished', () => {
    const worker = new FakeWorker()
    const walCheckpoints = new RowCacheWalCheckpoints(() => worker)
    const path = cachePath()
    const first = new KeyedJsonRowCache(path, { schemaVersion: 1, walCheckpoints })
    first.write([{ key: 'a', json: '"1"' }])
    first.close()
    writeFileSync(path, 'not a database')

    const second = new KeyedJsonRowCache(path, { schemaVersion: 1, walCheckpoints })
    expect(second.load(() => null)).toMatchObject({ kind: 'unavailable' })
    expect(() => second.write([{ key: 'b', json: '"2"' }])).toThrow(/SQLITE_BUSY/)
    expect(readFileSync(path, 'utf8')).toBe('not a database')

    worker.emit('message', { id: worker.posted[0]!.id, ok: true })
    second.write([{ key: 'b', json: '"2"' }])
    expect(second.load(() => null)).toEqual({ kind: 'rows', rows: [{ key: 'b', json: '"2"' }] })
    second.close()
  })

  it('keeps a file a failed worker may still be checkpointing until that worker exits', () => {
    const worker = new FakeWorker()
    const walCheckpoints = new RowCacheWalCheckpoints(() => worker)
    const path = cachePath()
    const cache = new KeyedJsonRowCache(path, { schemaVersion: 1, walCheckpoints })
    cache.write([{ key: 'a', json: '"1"' }])
    cache.close()
    worker.emit('error', new Error('worker crashed'))
    writeFileSync(path, 'not a database')

    const later = new KeyedJsonRowCache(path, { schemaVersion: 1, walCheckpoints })
    expect(() => later.write([{ key: 'b', json: '"2"' }])).toThrow(/SQLITE_BUSY/)
    worker.emit('exit', 1)
    later.write([{ key: 'b', json: '"2"' }])
    expect(later.load(() => null)).toEqual({ kind: 'rows', rows: [{ key: 'b', json: '"2"' }] })
    later.close()
  })

  it('fences only the file a failed worker was checkpointing, not ones still waiting', () => {
    const worker = new FakeWorker()
    const walCheckpoints = new RowCacheWalCheckpoints(() => worker)
    const busyPath = cachePath()
    const waitingPath = cachePath()
    const busy = new KeyedJsonRowCache(busyPath, { schemaVersion: 1, walCheckpoints })
    const waiting = new KeyedJsonRowCache(waitingPath, { schemaVersion: 1, walCheckpoints })
    busy.write([{ key: 'a', json: '"1"' }])
    waiting.write([{ key: 'a', json: '"1"' }])
    expect(worker.posted.map(({ path }) => path)).toEqual([busyPath])
    busy.close()
    waiting.close()
    worker.emit('error', new Error('worker crashed'))
    writeFileSync(busyPath, 'not a database')
    writeFileSync(waitingPath, 'not a database')

    const rebuilt = new KeyedJsonRowCache(waitingPath, { schemaVersion: 1, walCheckpoints })
    rebuilt.write([{ key: 'b', json: '"2"' }])
    const fenced = new KeyedJsonRowCache(busyPath, { schemaVersion: 1, walCheckpoints })
    expect(() => fenced.write([{ key: 'b', json: '"2"' }])).toThrow(/SQLITE_BUSY/)
    rebuilt.close()
    fenced.close()
  })

  it('folds every WAL frame of a live cache and never recreates a removed one', async () => {
    const path = cachePath()
    const db = new SyncDatabase(path)
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    db.exec('CREATE TABLE t(v TEXT); INSERT INTO t VALUES (1), (2), (3)')
    const worker = spawnRowCacheCheckpointWorker()
    const ask = (id: number, target: string) =>
      new Promise<{ id: number; ok: boolean }>((resolve) => {
        worker.on('message', (result: { id: number; ok: boolean }) => {
          if (result.id === id) {
            resolve(result)
          }
        })
        // Forced: a three-frame WAL is below the threshold an ordinary request waits for.
        worker.postMessage({ id, path: target, force: true })
      })
    try {
      const sqlite = db.prepare('SELECT sqlite_version() AS v').get()
      const [major, minor, patch] = String(sqlite?.v).split('.').map(Number)
      if (major === 3 && (minor < 51 || (minor === 51 && patch < 3))) {
        // Older SQLite: the worker declines, and connections keep checkpointing themselves.
        expect(await ask(1, path)).toMatchObject({ id: 1, ok: false, unsupported: true })
        return
      }
      expect(await ask(1, path)).toMatchObject({ id: 1, ok: true })
      const wal = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()
      expect(Number(wal?.log)).toBeGreaterThan(0)
      expect(wal?.checkpointed).toBe(wal?.log)
      const missing = join(path, '..', 'removed.db')
      expect(await ask(2, missing)).toMatchObject({ id: 2, ok: false })
      expect(existsSync(missing)).toBe(false)
    } finally {
      await worker.terminate()
      db.close()
    }
  })
})
