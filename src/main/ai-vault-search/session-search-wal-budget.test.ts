import { expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  openSessionSearchIndexFile,
  stagedWriteUpdate
} from './session-search-staged-write-test-fixture'
import { SessionSearchStore } from './session-search-store'
import { assertSearchWalBudget, SearchWalBackpressureError } from './session-search-wal-budget'

it('backpressures a pinned snapshot and resumes checkpoints after that reader releases', async () => {
  const index = await openSessionSearchIndexFile('ss-wal-budget')
  const reader = new SyncDatabase(index.path, { readonly: true })
  try {
    assertSearchWalBudget(index.db)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM sessions').get()
    index.db
      .prepare("INSERT INTO search_log(ts,query,route,hits,duration_ms) VALUES ('t',?,'or',0,0)")
      .run('synthetic'.repeat(10000))
    expect(() => assertSearchWalBudget(index.db, 4096)).toThrow(SearchWalBackpressureError)
    reader.exec('COMMIT')
    expect(() => assertSearchWalBudget(index.db, 4096)).not.toThrow()
  } finally {
    reader.close()
    await index.close()
  }
})

it('retains the old searchable generation and retries a backpressured write after reader release', async () => {
  const index = await openSessionSearchIndexFile('ss-wal-write')
  const errors: unknown[] = []
  const store = new SessionSearchStore(index.path, (error) => errors.push(error), {
    walBudgetBytes: 4096
  })
  const reader = new SyncDatabase(index.path, { readonly: true })
  try {
    await store.apply(stagedWriteUpdate('oldneedle', 1))
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM messages').get()
    await store.apply(stagedWriteUpdate('newneedle', 1000, 'append'))
    expect(errors.some((error) => error instanceof SearchWalBackpressureError)).toBe(true)
    expect(store.coverage().filesPending).toBe(1)
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    expect(store.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
    reader.exec('COMMIT')
    await store.apply(stagedWriteUpdate('newneedle', 1000, 'append'))
    await store.purgeOlderThan(null)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
    expect(store.coverage().filesPending).toBe(0)
    expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1001 })
  } finally {
    reader.close()
    store.close()
    await index.close()
  }
})

it('re-checks the budget mid-file when a reader pins after the write has started', async () => {
  const index = await openSessionSearchIndexFile('ss-wal-midfile')
  const errors: unknown[] = []
  const store = new SessionSearchStore(index.path, (error) => errors.push(error), {
    walBudgetBytes: 4096
  })
  const reader = new SyncDatabase(index.path, { readonly: true })
  try {
    // 2400 rows is 19 batches, so the sampled re-check at step 16 is the only
    // guard left once step 0 has already passed with nothing pinning the WAL.
    const write = store.apply(stagedWriteUpdate('midfileneedle', 2400))
    await new Promise((resolve) => setImmediate(resolve))
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM messages').get()
    await write

    expect(errors.some((error) => error instanceof SearchWalBackpressureError)).toBe(true)
    expect(store.search({ query: 'midfileneedle' }).hits).toHaveLength(0)
  } finally {
    reader.exec('COMMIT')
    reader.close()
    store.close()
    await index.close()
  }
})
