import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
    const pragmas: string[] = []
    const original = SyncDatabase.prototype.pragma
    vi.spyOn(SyncDatabase.prototype, 'pragma').mockImplementation(function (
      this: SyncDatabase,
      sql,
      options
    ) {
      pragmas.push(sql)
      return original.call(this, sql, options)
    })
    const worker = new FakeWorker()
    const path = cachePath()
    const cache = new KeyedJsonRowCache(path, {
      schemaVersion: 1,
      walCheckpoints: new RowCacheWalCheckpoints(() => worker)
    })

    cache.write([{ key: 'a', json: '"1"' }])
    // The commit leaves its checkpoint to the worker instead of running one itself.
    expect(pragmas).toContain('wal_autocheckpoint = 0')
    expect(worker.posted).toEqual([{ id: expect.any(Number), path }])

    worker.emit('error', new Error('worker crashed'))
    expect(pragmas.at(-1)).toBe('wal_autocheckpoint = 1000')
    // A failed worker is never used again; later commits checkpoint on their own.
    cache.write([{ key: 'b', json: '"2"' }])
    expect(worker.posted).toHaveLength(1)
    cache.close()
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
        worker.postMessage({ id, path: target })
      })
    try {
      expect(await ask(1, path)).toEqual({ id: 1, ok: true })
      const missing = join(path, '..', 'removed.db')
      expect(await ask(2, missing)).toEqual({ id: 2, ok: false })
      expect(existsSync(missing)).toBe(false)
    } finally {
      await worker.terminate()
      db.close()
    }
  })
})
