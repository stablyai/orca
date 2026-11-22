import { expect, it, vi } from 'vitest'
import { SessionSearchStore } from './session-search-store'
import { compactSessionSearchIndex } from './session-search-index-compaction'
import {
  ROWS,
  churnedStore,
  ftsBytes,
  insertRow,
  orphaningReplace,
  uncountedReplace
} from './session-search-index-compaction.test-fixture'

it('compacts an index whose replaced rows left their postings behind', async () => {
  const churned = await churnedStore('ss-index-compaction', orphaningReplace)
  const { index, compact } = churned
  let store = churned.store
  try {
    expect(ftsBytes(store.connection)).toBeGreaterThan(compact * 2)

    // The next open drains the orphaned rows, finds those deletes due and compacts.
    store.close()
    store = new SessionSearchStore(index.path)
    await vi.waitFor(
      () => {
        expect(store.connection.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n).toBe(ROWS)
        expect(ftsBytes(store.connection)).toBeLessThan(compact * 1.5)
      },
      { timeout: 20_000 }
    )
    expect(
      store.connection
        .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'term7'")
        .get()!.n
    ).toBeGreaterThan(0)
  } finally {
    store.close()
    await index.close()
  }
})

it('finishes compacting while indexing commits between its steps', async () => {
  const { index, store, compact } = await churnedStore('ss-index-compaction-busy', uncountedReplace)
  try {
    const db = store.connection
    let steps = 0
    await compactSessionSearchIndex(
      db,
      () => false,
      async () => {
        steps++
        insertRow(db, 1, ROWS + steps, 0)
      }
    )
    expect(ftsBytes(db)).toBeLessThan(compact * 1.5)
  } finally {
    store.close()
    await index.close()
  }
})
