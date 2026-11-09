import { expect, it } from 'vitest'
import { addSyntheticSession, openSessionSearchHarness } from './session-search-engine-test-fixture'
import { readIndexContentRevision, readIndexGeneration } from './session-search-index-generation'
import { encodeSessionSearchCursor, sessionSearchPageKey } from './session-search-page-cursor'
import { SessionSearchToolPurge } from './session-search-tool-purge'

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

type HarnessDb = Awaited<ReturnType<typeof openSessionSearchHarness>>['db']

function readMeta(db: HarnessDb, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? String(row.value) : undefined
}

function countTool(db: HarnessDb): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()!.n)
}

function newPurge(db: HarnessDb, closed = () => false, onChange = (): void => {}) {
  return new SessionSearchToolPurge(db, closed, onChange, (error) => {
    throw error
  })
}

it('persists a high-water mark so later passes skip already-scanned rowids', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge-mark')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'userkept', rows: 300 })
    addSyntheticSession(index.db, { id: 2, role: 'tool', text: 'toolremoved', rows: 300 })
    const purge = newPurge(index.db)
    await purge.request()
    expect(countTool(index.db)).toBe(0)
    const mark = Number(readMeta(index.db, 'tool_purge_scanned_rowid'))
    expect(mark).toBeGreaterThanOrEqual(600)
    expect(readMeta(index.db, 'tool_purge_floor_rowid')).toBeUndefined()

    // Without the floor trigger, a row below the mark is invisible to later passes: no rescan.
    index.db.exec('DROP TRIGGER search_tool_purge_floor')
    index.db.exec('DELETE FROM messages WHERE id = 1')
    index.db.exec("INSERT INTO messages(id, session_row_id, role) VALUES (1, 1, 'tool')")
    await purge.request()
    expect(countTool(index.db)).toBe(1)
    expect(Number(readMeta(index.db, 'tool_purge_scanned_rowid'))).toBe(mark)
  } finally {
    await index.close()
  }
})

it('purges legacy tool rows written after the mark, including reused tail rowids', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge-downgrade')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'userkept', rows: 20 })
    const purge = newPurge(index.db)
    await purge.request()
    const mark = Number(readMeta(index.db, 'tool_purge_scanned_rowid'))
    expect(mark).toBeGreaterThanOrEqual(20)
    // A downgraded build deletes the tail, then reuses those rowids for tool rows.
    index.db.exec('DELETE FROM messages WHERE id > 10')
    index.db.exec('DELETE FROM messages_fts WHERE rowid > 10')
    addSyntheticSession(index.db, { id: 3, role: 'tool', text: 'reusedtool', rows: 5 })
    const reused = index.db.prepare("SELECT MIN(id) AS id FROM messages WHERE role = 'tool'").get()
    expect(Number(reused!.id)).toBeLessThanOrEqual(mark)
    expect(Number(readMeta(index.db, 'tool_purge_floor_rowid'))).toBe(10)
    addSyntheticSession(index.db, { id: 4, role: 'tool', text: 'latertool', rows: 400 })
    await purge.request()
    expect(countTool(index.db)).toBe(0)
    expect(index.engine.search({ query: 'reusedtool' }).hits).toEqual([])
    expect(index.engine.search({ query: 'userkept' }).hits[0]?.sessionId).toBe('1')
    expect(readMeta(index.db, 'tool_purge_floor_rowid')).toBeUndefined()
    expect(Number(readMeta(index.db, 'tool_purge_scanned_rowid'))).toBeGreaterThanOrEqual(415)
  } finally {
    await index.close()
  }
})

it('keeps the claimed start when a pass is cancelled', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge-cancel')
  try {
    addSyntheticSession(index.db, { id: 1, role: 'tool', text: 'toolremoved', rows: 600 })
    let closed = false
    let cancels = 1
    const purge = newPurge(
      index.db,
      () => closed,
      () => {
        closed = cancels-- > 0
      }
    )
    await purge.request()
    expect(countTool(index.db)).toBe(344)
    expect(readMeta(index.db, 'tool_purge_scanned_rowid')).toBe('0')
    closed = false
    await purge.request()
    expect(countTool(index.db)).toBe(0)
  } finally {
    await index.close()
  }
})
