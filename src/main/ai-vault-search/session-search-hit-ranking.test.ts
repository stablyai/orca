import { describe, expect, it } from 'vitest'
import { rankSessionHits, type MessageRow, type SessionRow } from './session-search-hit-ranking'

function session(id: number, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    agent: 'claude',
    session_id: String(id),
    file_path: `/synthetic/${id}.jsonl`,
    codex_home: null,
    title: 'fixture',
    cwd: '/repo/app',
    branch: null,
    updated_at: '2026-09-01T00:00:00.000Z',
    message_count: 1,
    resume_command: 'resume',
    content_hash: null,
    content_hash_count: 0,
    ...overrides
  }
}

function match(id: number, score: number): MessageRow {
  return { rowid: id, score, session_row_id: id, role: 'user', ts: null }
}

function matches(...rows: MessageRow[]): Map<number, MessageRow> {
  return new Map(rows.map((row) => [row.session_row_id, row]))
}

describe('order', () => {
  it('ranks by score under relevance and by recency under newest', () => {
    const sessions = [
      session(1, { updated_at: '2026-09-01T00:00:00.000Z' }),
      session(2, { updated_at: '2026-09-09T00:00:00.000Z' })
    ]
    const scores = matches(match(1, 10), match(2, 1))
    expect(rankSessionHits(sessions, scores, 'relevance').map((e) => e.session.id)).toEqual([1, 2])
    expect(rankSessionHits(sessions, scores, 'newest').map((e) => e.session.id)).toEqual([2, 1])
  })

  it.each(['relevance', 'newest'] as const)(
    'breaks a %s tie by session, whatever order retrieval handed them over in',
    (sort) => {
      // A cursor is an offset into this list, so two entries that tie must not
      // be free to swap between pages. Retrieval hands sessions over in
      // whatever order the `IN (...)` lookup produced, which SQL does not
      // promise, so the order below is deliberately reversed.
      const sessions = [6, 5, 4, 3, 2, 1].map((id) => session(id))
      const scores = matches(...sessions.map((entry) => match(entry.id, 5)))
      expect(rankSessionHits(sessions, scores, sort).map((entry) => entry.session.id)).toEqual([
        1, 2, 3, 4, 5, 6
      ])
    }
  )

  it('prefers the shorter session when two match equally well', () => {
    // The length prior: `0.02 · ln(1 + messages)`, subtracted per session.
    const sessions = [session(1, { message_count: 5000 }), session(2, { message_count: 2 })]
    const ranked = rankSessionHits(sessions, matches(match(1, 5), match(2, 5)), 'relevance')
    expect(ranked.map((entry) => entry.session.id)).toEqual([2, 1])
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
  })
})

describe('forks fold into one answer', () => {
  const fork = (id: number, updatedAt: string): SessionRow =>
    session(id, {
      updated_at: updatedAt,
      content_hash: 'shared-opening-prefix',
      content_hash_count: 8
    })

  it('keeps the newest copy and counts the rest', () => {
    const sessions = [
      fork(1, '2026-09-01T00:00:00.000Z'),
      fork(2, '2026-09-09T00:00:00.000Z'),
      fork(3, '2026-09-05T00:00:00.000Z')
    ]
    const ranked = rankSessionHits(
      sessions,
      matches(match(1, 9), match(2, 1), match(3, 5)),
      'relevance'
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0]!.session.id).toBe(2)
    expect(ranked[0]!.duplicateCount).toBe(3)
  })

  it('leaves sessions with no shared prefix alone', () => {
    const sessions = [session(1), session(2)]
    const ranked = rankSessionHits(sessions, matches(match(1, 9), match(2, 5)), 'relevance')
    expect(ranked.map((entry) => entry.duplicateCount)).toEqual([1, 1])
  })
})

it('scores a session that matched no text at zero, less its length prior', () => {
  // The operator-only page: there is no relevance signal, only an order.
  const ranked = rankSessionHits([session(1, { message_count: 9 })], new Map(), 'newest')
  expect(ranked[0]!.message).toBeNull()
  expect(ranked[0]!.score).toBeLessThan(0)
})
