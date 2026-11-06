import { expect, it } from 'vitest'
import { addSyntheticSession, openSessionSearchHarness } from './session-search-engine-test-fixture'
import { readIndexGeneration } from './session-search-index-generation'
import { SessionSearchToolPurge, readSessionSearchToolPurgePage } from './session-search-tool-purge'

it('purges legacy tool rows across batches while preserving conversations and invalidating pages', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'userkept' })
    addSyntheticSession(index.db, { id: 2, role: 'assistant', text: 'assistantkept' })
    addSyntheticSession(index.db, { id: 3, role: 'tool', text: 'toolremoved', rows: 600 })
    const before = readIndexGeneration(index.db)
    expect(index.engine.search({ query: 'toolremoved' }).hits).toHaveLength(1)
    let messages = 602
    const errors: unknown[] = []
    const purge = new SessionSearchToolPurge(
      index.db,
      () => false,
      (delta) => {
        messages += delta
      },
      (error) => errors.push(error)
    )
    await purge.request()
    expect(errors).toEqual([])
    expect(index.engine.search({ query: 'toolremoved' }).hits).toEqual([])
    expect(index.engine.search({ query: 'userkept' }).hits[0]?.sessionId).toBe('1')
    expect(index.engine.search({ query: 'assistantkept' }).hits[0]?.sessionId).toBe('2')
    expect(messages).toBe(2)
    expect(readIndexGeneration(index.db)).toBeGreaterThan(before)
    addSyntheticSession(index.db, { id: 4, role: 'tool', text: 'newlegacytool' })
    await purge.request()
    expect(index.engine.search({ query: 'newlegacytool' }).hits).toEqual([])
  } finally {
    await index.close()
  }
})

it('bounds empty conversation pages and seeks across sparse rowid gaps', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge-sparse')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'kept', rows: 300 })
    addSyntheticSession(index.db, { id: 2, text: 'legacytool', role: 'tool' })
    index.db.exec('UPDATE messages SET id = 1000000 WHERE id = 301')
    const first = readSessionSearchToolPurgePage(index.db, 0)
    expect(first).toEqual({ cursor: 256, ids: [] })
    expect(readSessionSearchToolPurgePage(index.db, 256)).toEqual({ cursor: 512, ids: [] })
    expect(readSessionSearchToolPurgePage(index.db, 512)).toEqual({
      cursor: 1000255,
      ids: [{ id: 1000000 }]
    })
    expect(readSessionSearchToolPurgePage(index.db, 1000255)).toBeNull()
  } finally {
    await index.close()
  }
})
