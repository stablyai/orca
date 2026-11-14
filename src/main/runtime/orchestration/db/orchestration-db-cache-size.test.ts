import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

// Negative cache_size is KiB. SQLite's default -2000 is about 2 MiB, which a
// worker-list scan of a large Run does not fit (#40821).
const SQLITE_DEFAULT_CACHE_KIB = -2000
const WORKER_LIST_CACHE_KIB = -65536

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

describe('orchestration connection cache', () => {
  it('keeps a worker-list scan in a cache larger than the 2 MiB SQLite default', () => {
    db = new OrchestrationDb(':memory:')

    const cacheKiB = db.db.pragma('cache_size', { simple: true })

    expect(cacheKiB).toBeTypeOf('number')
    expect(cacheKiB).toBeLessThan(SQLITE_DEFAULT_CACHE_KIB)
    expect(cacheKiB).toBeLessThanOrEqual(WORKER_LIST_CACHE_KIB)
  })
})
