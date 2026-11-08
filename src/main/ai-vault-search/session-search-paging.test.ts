import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSearchRequest } from './session-search-engine-types'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { readIndexGeneration } from './session-search-index-generation'
import {
  decodeSessionSearchCursor,
  encodeSessionSearchCursor,
  SessionSearchCursorError
} from './session-search-page-cursor'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

async function open(name: string, options = {}): Promise<SessionSearchHarness> {
  harness = await openSessionSearchHarness(name, options)
  return harness
}

async function withSessions(count: number, options = {}): Promise<SessionSearchHarness> {
  harness = await openSessionSearchHarness('ss-engine-paging', options)
  for (let id = 1; id <= count; id++) {
    addSyntheticSession(harness.db, {
      id,
      text: `needle padding ${'word '.repeat(id % 5)}`,
      updatedAt: `2026-09-${String(id).padStart(2, '0')}T00:00:00.000Z`
    })
  }
  return harness
}

describe('a cursor walks one ranked list', () => {
  it('pages through every session exactly once, in one stable order', async () => {
    const { engine } = await withSessions(25)
    const request: SessionSearchRequest = { query: 'needle', limit: 10 }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = engine.search(cursor ? { ...request, cursor } : request)
      seen.push(...page.hits.map((hit) => hit.sessionId))
      cursor = page.page.cursor
      pages++
      expect(pages).toBeLessThan(10)
    } while (cursor !== null)

    expect(pages).toBe(3)
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
    expect(engine.search(request).hits.map((hit) => hit.sessionId)).toEqual(seen.slice(0, 10))
  })

  it('lets a caller change page size mid-walk', async () => {
    const { engine } = await withSessions(12)
    const first = engine.search({ query: 'needle', limit: 5 })
    const rest = engine.search({ query: 'needle', limit: 20, cursor: first.page.cursor! })
    expect(rest.hits).toHaveLength(7)
    expect(rest.page.hasMore).toBe(false)
  })

  it('breaks a tie by session, so two entries cannot swap between pages', async () => {
    // Equal relevance and timestamps force the session-ID tie-breaker.
    harness = await openSessionSearchHarness('ss-engine-ties')
    for (let id = 1; id <= 6; id++) {
      addSyntheticSession(harness.db, { id, text: 'needle', updatedAt: '2026-09-01T00:00:00.000Z' })
    }
    const first = harness.engine.search({ query: 'needle', limit: 3 })
    const second = harness.engine.search({ query: 'needle', limit: 3, cursor: first.page.cursor! })
    const seen = [...first.hits, ...second.hits].map((hit) => hit.sessionId)
    expect(seen).toEqual(['1', '2', '3', '4', '5', '6'])
  })
})

describe('a cursor is refused rather than reinterpreted', () => {
  it('rejects a cursor minted before the index moved', async () => {
    const { engine, store } = await withSessions(25)
    const first = engine.search({ query: 'needle', limit: 10 })
    store.removeFile('/synthetic/1.jsonl')

    expect(() => engine.search({ query: 'needle', limit: 10, cursor: first.page.cursor! })).toThrow(
      SessionSearchCursorError
    )
    try {
      engine.search({ query: 'needle', limit: 10, cursor: first.page.cursor! })
      expect.unreachable('a stale cursor must not be silently re-run')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('stale-generation')
    }
  })

  it('rejects a cursor carried over to a different query', async () => {
    const { engine } = await withSessions(25)
    const first = engine.search({ query: 'needle', limit: 10 })
    try {
      engine.search({ query: 'padding', limit: 10, cursor: first.page.cursor! })
      expect.unreachable('a cursor indexes into one ranked list, not any list')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('different-query')
    }
  })

  it.each([
    ['scope', { scope: 'conversation' as const }],
    ['sort', { filters: { sort: 'newest' as const } }],
    ['agents', { filters: { agents: ['codex' as const] } }],
    ['scopePaths', { filters: { scopePaths: ['/repo/app'] } }],
    ['since', { filters: { since: '2026-09-01T00:00:00.000Z' } }]
  ])('rejects a cursor presented with a different %s', async (_field, changed) => {
    const { engine } = await withSessions(25)
    const request: SessionSearchRequest = {
      query: 'needle',
      limit: 10,
      scope: 'all',
      filters: { sort: 'relevance', agents: ['claude'], scopePaths: ['/'], since: undefined }
    }
    const first = engine.search(request)
    expect(first.page.cursor).not.toBeNull()
    try {
      engine.search({
        ...request,
        ...changed,
        filters: { ...request.filters, ...('filters' in changed ? changed.filters : {}) },
        cursor: first.page.cursor!
      })
      expect.unreachable('a narrowing the ranked list depends on must invalidate the cursor')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('different-query')
    }
  })
})

describe('cursor encoding', () => {
  const incarnation = 'index-a'

  it.each([
    ['a negative offset', encodeSessionSearchCursor(1, -1, 'k', incarnation), 1],
    ['a non-integer offset', Buffer.from('{"g":1,"o":1.5,"k":"k"}').toString('base64url'), 1],
    ['a payload that is not an object', Buffer.from('"nope"').toString('base64url'), undefined],
    ['text that is not base64url JSON', 'zzz!!', undefined],
    [
      'a fractional generation',
      Buffer.from('{"g":7.5,"o":0,"k":"k"}').toString('base64url'),
      undefined
    ],
    [
      'a negative generation',
      Buffer.from('{"g":-1,"o":0,"k":"k"}').toString('base64url'),
      undefined
    ]
  ])('rejects %s as malformed, still naming the index generation', (_name, cursor, claimed) => {
    try {
      decodeSessionSearchCursor(cursor, 7, 'k', incarnation)
      expect.unreachable('a malformed cursor is not an empty one')
    } catch (error) {
      const rejected = error as SessionSearchCursorError
      expect(rejected.rejection).toBe('malformed')
      expect(rejected.actualGeneration).toBe(7)
      expect(rejected.expectedGeneration).toBe(claimed)
    }
  })

  it('treats legacy and previous-incarnation cursors as stale', () => {
    const legacy = Buffer.from('{"g":7,"o":1,"k":"k"}').toString('base64url')
    for (const cursor of [legacy, encodeSessionSearchCursor(7, 1, 'k', 'index-before')]) {
      expect(() => decodeSessionSearchCursor(cursor, 7, 'k', incarnation)).toThrow(
        'stale-generation'
      )
    }
  })
})

describe('the candidate limit is a tunable default, and says when it cut', () => {
  it('claims truncation, and ranks only what it retrieved, at the limit', async () => {
    const { engine } = await withSessions(10, { sessionCandidateLimit: 4 })
    const result = engine.search({ query: 'needle', limit: 100 })
    expect(result.truncated.candidates).toBe(true)
    expect(result.hits).toHaveLength(4)
  })

  it('applies the same limit to an operator-only page', async () => {
    const { engine } = await withSessions(10, { sessionCandidateLimit: 4 })
    const result = engine.search({ query: 'repo:app', limit: 100 })
    expect(result.truncated.candidates).toBe(true)
    expect(result.hits).toHaveLength(4)
  })

  it('says it gave up when the operator walk stopped scanning, not that it is done', async () => {
    // Put the only match beyond one scan page and the candidateLimit × 20 ceiling.
    const deep = 600
    const { db, engine } = await open('ss-engine-sparse-deep', { sessionCandidateLimit: 2 })
    for (let id = 1; id <= deep; id++) {
      addSyntheticSession(db, {
        id,
        cwd: id === deep ? '/repo/needleonly' : '/repo/app',
        updatedAt: new Date(Date.UTC(2026, 8, 9) - id * 60_000).toISOString()
      })
    }
    const result = engine.search({ query: 'repo:needleonly' })
    expect(result.hits).toHaveLength(0)
    expect(result.truncated.candidates).toBe(true)
  })
})

it.each([false, true])('rejects a write during page assembly (cursor: %s)', async (withCursor) => {
  const { db, engine, store } = await open('ss-concurrent-page')
  for (let id = 1; id <= 3; id++) {
    addSyntheticSession(db, { id, text: 'needle' })
  }
  const first = engine.search({ query: 'needle', limit: 1 })
  const prepare = db.prepare.bind(db)
  let committed = false
  const hook = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (!committed && sql.includes('SELECT DISTINCT session_row_id FROM files')) {
      committed = true
      store.removeFile('/synthetic/1.jsonl')
    }
    return prepare(sql)
  })
  try {
    expect(() =>
      engine.search({
        query: 'needle',
        limit: 1,
        ...(withCursor ? { cursor: first.page.cursor! } : {})
      })
    ).toThrow(SessionSearchCursorError)
    expect(committed).toBe(true)
    expect(readIndexGeneration(db)).toBeGreaterThan(first.generation)
  } finally {
    hook.mockRestore()
  }
})
