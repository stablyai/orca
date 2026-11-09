import { expect, it } from 'vitest'
import { addSyntheticSession, openSessionSearchHarness } from './session-search-engine-test-fixture'
import { readIndexContentRevision, readIndexGeneration } from './session-search-index-generation'
import { encodeSessionSearchCursor, sessionSearchPageKey } from './session-search-page-cursor'
import { SessionSearchToolPurge, readSessionSearchToolPurgePage } from './session-search-tool-purge'

it('purges legacy tool rows across batches while preserving conversations and raw generation fences', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'userkept' })
    addSyntheticSession(index.db, { id: 2, role: 'assistant', text: 'assistantkept' })
    addSyntheticSession(index.db, { id: 3, role: 'tool', text: 'toolremoved', rows: 600 })
    const before = readIndexGeneration(index.db)
    expect(index.engine.search({ query: 'toolremoved' }).hits).toHaveLength(0)
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

it.each(['relevance', 'newest'] as const)(
  'continues frozen %s ordering and fork folding throughout tool cleanup',
  async (sort) => {
    const index = await openSessionSearchHarness('ss-frozen-purge')
    try {
      for (let id = 1; id <= 7; id++) {
        addSyntheticSession(index.db, {
          id,
          text: 'needle',
          messageCount: id,
          updatedAt: `2026-09-0${id}T00:00:00.000Z`
        })
      }
      index.db.exec(
        "UPDATE sessions SET content_hash = 'shared', content_hash_count = 8 WHERE id IN (2,7)"
      )
      addSyntheticSession(index.db, {
        id: 20,
        role: 'tool',
        text: 'needle noisy words',
        rows: 2500
      })
      // Orphan deletes fire generation triggers in addition to the purge's explicit bump.
      index.db.exec('DELETE FROM sessions WHERE id = 20')
      const before = readIndexContentRevision(index.db)
      const request = { query: 'needle', limit: 1, filters: { sort } }
      const first = index.engine.search(request)
      const incarnation = String(
        index.db.prepare("SELECT value FROM meta WHERE key = 'index_incarnation'").get()!.value
      )
      const legacy = encodeSessionSearchCursor(
        first.generation,
        1,
        sessionSearchPageKey(request),
        incarnation
      )
      const seen = [...first.hits]
      let cursor = first.page.cursor
      const errors: unknown[] = []
      await new SessionSearchToolPurge(
        index.db,
        () => false,
        () => {
          if (cursor) {
            const page = index.engine.search({ ...request, cursor })
            expect(page.generation).toBe(first.generation)
            seen.push(...page.hits)
            cursor = page.page.cursor
          }
        },
        (error) => errors.push(error)
      ).request()
      expect(errors).toEqual([])
      expect(cursor).toBeNull()
      expect(seen.map((hit) => hit.sessionId)).toEqual(
        sort === 'newest' ? ['7', '6', '5', '4', '3', '1'] : ['1', '3', '4', '5', '6', '7']
      )
      expect(seen.find((hit) => hit.sessionId === '7')?.duplicateCount).toBe(2)
      expect(readIndexContentRevision(index.db)).toBe(before)
      expect(readIndexGeneration(index.db)).toBeGreaterThan(first.generation)
      expect(() => index.engine.search({ ...request, cursor: legacy })).toThrow('stale-generation')
    } finally {
      await index.close()
    }
  }
)
