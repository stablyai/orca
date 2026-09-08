import { expect, it } from 'vitest'
import { SessionSearchStore } from './session-search-store'
import { SessionSearchIndexWriter, SEARCH_WRITE_ROWS_PER_STEP } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  stagedWriteUpdate as update
} from './session-search-staged-write-test-fixture'

function stagedRows(db: { prepare: (sql: string) => { get: () => unknown } }): number {
  return (
    db
      .prepare(
        'SELECT count(*) AS n FROM messages WHERE batch_id IN (SELECT id FROM search_write_batches)'
      )
      .get() as { n: number }
  ).n
}

function messageCount(db: { prepare: (sql: string) => { get: () => unknown } }): number {
  return (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n
}

it.each(['replace', 'append'] as const)(
  'publishes a large %s atomically after bounded steps',
  async (mode) => {
    const index = await openSessionSearchIndexFile('ss-staged-publish')
    const store = new SessionSearchStore(index.path)
    const writer = new SessionSearchIndexWriter(index.db)
    try {
      await writer.apply(update('oldneedle', 1))
      let steps = 0,
        previous = 0
      const applied = await writer.apply(update('newneedle', 1000, mode), {
        yieldStep: async () => {
          const rows = stagedRows(index.db)
          expect(rows - previous).toBeLessThanOrEqual(SEARCH_WRITE_ROWS_PER_STEP)
          previous = rows
          steps++
          expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
          expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
          expect(writer.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
        }
      })
      expect(applied).toBe(true)
      expect(steps).toBe(8)
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
      expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(mode === 'append' ? 1 : 0)
      expect(store.search({ query: 'newneedle' }).hits[0].title).toBe('newneedle')
      await store.purgeOlderThan(null)
      expect(messageCount(index.db)).toBe(mode === 'append' ? 1001 : 1000)
    } finally {
      store.close()
      await index.close()
    }
  }
)

it.each(['replace', 'append'] as const)(
  'recovers an interrupted %s without publishing rows or advancing its cursor',
  async (mode) => {
    const index = await openSessionSearchIndexFile('ss-staged-recover')
    let store = new SessionSearchStore(index.path)
    let open = true
    try {
      const writer = new SessionSearchIndexWriter(index.db)
      await writer.apply(update('oldneedle', 1))
      expect(
        await writer.apply(update('newneedle', 1000, mode), {
          active: () => open,
          yieldStep: async () => {
            store.close()
            open = false
          }
        })
      ).toBe(false)
      store = new SessionSearchStore(index.path)
      open = true
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
      expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
      expect(store.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
      await store.purgeOlderThan(null)
      expect(messageCount(index.db)).toBe(1)
      await store.apply(update('newneedle', 1000, mode))
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
    } finally {
      if (open) {
        store.close()
      }
      await index.close()
    }
  }
)

it('does not resurrect a newly invalidated file or retain a cancelled append', async () => {
  const index = await openSessionSearchIndexFile('ss-staged-invalidated')
  const store = new SessionSearchStore(index.path)
  const writer = new SessionSearchIndexWriter(index.db)
  try {
    expect(
      await writer.apply(update('newneedle', 1000), {
        yieldStep: async () => {
          writer.removeFile('synthetic-transcript')
        }
      })
    ).toBe(false)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    await store.purgeOlderThan(null)
    await writer.apply(update('oldneedle', 1))
    let accepted = true
    expect(
      await writer.apply(update('newneedle', 1000, 'append'), {
        active: () => accepted,
        yieldStep: async () => {
          accepted = false
        },
        available: () => true
      })
    ).toBe(false)
    await store.purgeOlderThan(null)
    expect(messageCount(index.db)).toBe(1)
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
  } finally {
    store.close()
    await index.close()
  }
})

it('does not suggest unpublished vocabulary while a large update is being written', async () => {
  const index = await openSessionSearchIndexFile('ss-staged-vocab')
  const store = new SessionSearchStore(index.path)
  const writer = new SessionSearchIndexWriter(index.db)
  try {
    await writer.apply(update('oldneedle', 1))
    await writer.apply(update('coalesces', 1000, 'append'), {
      yieldStep: async () => {
        const result = store.search({ query: 'coalescs' })
        expect(result.hits).toHaveLength(0)
        expect(result.repairedTerms).toBeUndefined()
      }
    })
    expect(store.search({ query: 'coalescs' }).repairedTerms).toEqual(['coalesces'])
  } finally {
    store.close()
    await index.close()
  }
})

it('keeps published rows visible when a later batch reuses the freed id', async () => {
  const index = await openSessionSearchIndexFile('ss-staged-batch-reuse')
  const store = new SessionSearchStore(index.path)
  const writer = new SessionSearchIndexWriter(index.db)
  const inFlightBatchId = (): number =>
    (index.db.prepare('SELECT id FROM search_write_batches').get() as { id: number }).id
  try {
    let published: number | null = null
    await writer.apply(update('oldneedle', 1000), {
      yieldStep: async () => {
        published ??= inFlightBatchId()
      }
    })
    let reused: number | null = null
    await writer.apply(update('newneedle', 1000, 'append'), {
      yieldStep: async () => {
        reused ??= inFlightBatchId()
        expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
      }
    })
    // Without this the test proves nothing: SQLite hands the freed rowid straight back.
    expect(reused).toBe(published)
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
  } finally {
    store.close()
    await index.close()
  }
})

it('keeps published data and queues recovery when an append cursor is stale', async () => {
  const store = new SessionSearchStore(':memory:')
  try {
    await store.apply(update('oldneedle', 1))
    await store.apply(update('newneedle', 1, 'append'))
    await store.apply(update('staleneedle', 1, 'append'))
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'staleneedle' }).hits).toHaveLength(0)
    expect(store.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(2)
    expect(store.coverage().filesPending).toBe(1)
  } finally {
    store.close()
  }
})
