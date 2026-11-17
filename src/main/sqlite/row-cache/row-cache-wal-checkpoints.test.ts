import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sync-database'
import { KeyedJsonRowCache } from './keyed-json-row-cache'
import { RowCacheWalCheckpoints } from './row-cache-wal-checkpoints'

class FakeWorker extends EventEmitter {
  readonly posted: unknown[] = []
  postMessage(message: unknown): void {
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
  it('runs one checkpoint per file at a time and queues one more for commits during it', () => {
    const worker = new FakeWorker()
    const checkpoints = new RowCacheWalCheckpoints(() => worker)
    expect(checkpoints.attach('/a.db', () => {})).toBe(true)

    checkpoints.request('/a.db')
    checkpoints.request('/a.db')
    checkpoints.request('/a.db')
    expect(worker.posted).toEqual([{ path: '/a.db' }])

    worker.emit('message', { path: '/a.db', ok: true })
    expect(worker.posted).toEqual([{ path: '/a.db' }, { path: '/a.db' }])
    worker.emit('message', { path: '/a.db', ok: true })
    expect(worker.posted).toHaveLength(2)
  })

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
    const checkpoints = new RowCacheWalCheckpoints(() => worker)
    const path = cachePath()
    const cache = new KeyedJsonRowCache(path, { schemaVersion: 1, walCheckpoints: checkpoints })

    cache.write([{ key: 'a', json: '"1"' }])
    // The commit leaves its checkpoint to the worker instead of running one itself.
    expect(pragmas).toContain('wal_autocheckpoint = 0')
    expect(worker.posted).toEqual([{ path }])

    worker.emit('error', new Error('worker crashed'))
    expect(pragmas.at(-1)).toBe('wal_autocheckpoint = 1000')
    // A failed worker is never used again; later commits checkpoint on their own.
    cache.write([{ key: 'b', json: '"2"' }])
    expect(worker.posted).toHaveLength(1)
    cache.close()
  })
})
