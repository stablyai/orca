import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSearchRequest } from './session-search-engine-types'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import {
  decodeSessionSearchCursor,
  encodeSessionSearchCursor,
  SessionSearchCursorError,
  sessionSearchPageKey
} from './session-search-page-cursor'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

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
    // The same walk, run again against the same generation, is the same walk.
    expect(engine.search(request).hits.map((hit) => hit.sessionId)).toEqual(seen.slice(0, 10))
  })

  it('closes the page when the last hit has been handed out', async () => {
    const { engine } = await withSessions(3)
    const page = engine.search({ query: 'needle', limit: 10 })
    expect(page.hits).toHaveLength(3)
    expect(page.page.hasMore).toBe(false)
    expect(page.page.cursor).toBeNull()
  })

  it('lets a caller change page size mid-walk', async () => {
    const { engine } = await withSessions(12)
    const first = engine.search({ query: 'needle', limit: 5 })
    const rest = engine.search({ query: 'needle', limit: 20, cursor: first.page.cursor! })
    expect(rest.hits).toHaveLength(7)
    expect(rest.page.hasMore).toBe(false)
  })

  it('breaks a tie by session, so two entries cannot swap between pages', async () => {
    // Same text, same timestamp: every ranking key is equal, which is exactly
    // where an unstable sort would hand one session out twice and lose another.
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
    // Any published write or proven deletion moves the generation on.
    store.removeFile('/synthetic/absent.jsonl')

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

  it('rejects a cursor whose filters changed, which reranks the list', async () => {
    const { engine } = await withSessions(25)
    const first = engine.search({ query: 'needle', limit: 10 })
    try {
      engine.search({
        query: 'needle',
        limit: 10,
        cursor: first.page.cursor!,
        filters: { sort: 'newest' }
      })
      expect.unreachable('a different sort is a different ranked list')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('different-query')
    }
  })

  it('rejects a cursor that is not one of ours', async () => {
    const { engine } = await withSessions(3)
    try {
      engine.search({ query: 'needle', cursor: 'not-a-cursor' })
      expect.unreachable('a malformed cursor is not an empty one')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('malformed')
    }
  })
})

describe('cursor encoding', () => {
  const request: SessionSearchRequest = { query: 'needle', filters: { scopePaths: ['/a'] } }

  it('round-trips an offset within its own generation and query', () => {
    const key = sessionSearchPageKey(request)
    expect(decodeSessionSearchCursor(encodeSessionSearchCursor(7, 40, key), 7, key)).toBe(40)
  })

  it('keys a request by what changes its ranking, and not by its page size', () => {
    expect(sessionSearchPageKey({ ...request, limit: 5 })).toBe(
      sessionSearchPageKey({ ...request, limit: 50 })
    )
    expect(sessionSearchPageKey({ ...request, scope: 'conversation' })).not.toBe(
      sessionSearchPageKey(request)
    )
  })

  it('reads a filter list in any order as the same request', () => {
    expect(sessionSearchPageKey({ query: 'a', filters: { agents: ['claude', 'codex'] } })).toBe(
      sessionSearchPageKey({ query: 'a', filters: { agents: ['codex', 'claude'] } })
    )
  })

  it.each([
    ['a negative offset', encodeSessionSearchCursor(1, -1, 'k')],
    ['a non-integer offset', Buffer.from('{"g":1,"o":1.5,"k":"k"}').toString('base64url')],
    ['a payload that is not an object', Buffer.from('"nope"').toString('base64url')],
    ['text that is not base64url JSON', 'zzz!!']
  ])('rejects %s as malformed', (_name, cursor) => {
    expect(() => decodeSessionSearchCursor(cursor, 1, 'k')).toThrow(SessionSearchCursorError)
  })
})

describe('the candidate limit is a tunable default, and says when it cut', () => {
  it('does not claim truncation when every session fits', async () => {
    const { engine } = await withSessions(5, { sessionCandidateLimit: 600 })
    expect(engine.search({ query: 'needle' }).truncated.candidates).toBe(false)
  })

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
})

describe('the response carries the snapshot it was built from', () => {
  it('reports the store generation on every result', async () => {
    const { engine, store } = await withSessions(3)
    expect(engine.search({ query: 'needle' }).generation).toBe(store.generation)
    store.removeFile('/synthetic/absent.jsonl')
    expect(engine.search({ query: 'needle' }).generation).toBe(store.generation)
  })
})
