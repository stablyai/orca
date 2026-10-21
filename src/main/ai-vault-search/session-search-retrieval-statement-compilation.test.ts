import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { planSessionSearchQuery } from './session-search-query-planner'
import { SessionSearchRetrieval, type RetrievalScope } from './session-search-retrieval'
import { sessionRowFilter } from './session-search-row-filter'

let harness: SessionSearchHarness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})

async function seededRetrieval(): Promise<SessionSearchRetrieval> {
  harness = await openSessionSearchHarness('ss-retrieval-compilation')
  for (let id = 1; id <= 513; id += 1) {
    addSyntheticSession(harness.db, {
      id,
      agent: id % 2 === 0 ? 'claude' : 'codex',
      cwd: id % 3 === 0 ? null : 'C:\\Work\\App',
      text: 'needle'
    })
  }
  harness.db
    .prepare(
      `UPDATE sessions SET codex_home = ?, branch = ?, created_at = ?,
       content_hash = ?, content_hash_count = ? WHERE id = ?`
    )
    .run('C:\\Accounts\\primary', 'feature', '2026-08-01T00:00:00.000Z', 'hash', 8, 2)
  return new SessionSearchRetrieval(harness.db)
}

function scope(): RetrievalScope {
  return {
    scope: 'all',
    sort: 'relevance',
    filter: sessionRowFilter({}),
    matchesOperators: () => true,
    candidateLimit: 600
  }
}

describe('session retrieval statement compilation', () => {
  it('reuses recent-page statements across pages and fresh filter values without dropping columns', async () => {
    const retrieval = await seededRetrieval()
    if (!harness) {
      throw new Error('Missing search harness')
    }
    const expected = harness.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id DESC')
      .all()
    const schemas = harness.db.pragma('table_info(sessions)')
    if (!Array.isArray(schemas)) {
      throw new Error('Missing session schema')
    }
    expect(Object.keys(expected[0] ?? {}).sort()).toEqual(
      schemas.map((column) => column.name).sort()
    )
    const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')

    for (let call = 0; call < 5; call += 1) {
      const all = retrieval.recent({ ...scope(), matchesOperators: (row) => row.id % 2 === 0 })
      expect(all).toEqual({
        sessions: expected.filter((row) => Number(row.id) % 2 === 0),
        incomplete: false
      })
      for (const agent of ['claude', 'codex'] as const) {
        const filtered = retrieval.recent({
          ...scope(),
          filter: sessionRowFilter({ agents: [agent] })
        })
        expect(filtered).toEqual({
          sessions: expected.filter((row) => row.agent === agent),
          incomplete: false
        })
      }
    }

    expect(compile).toHaveBeenCalledTimes(2)
    harness.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('fresh title', 2)
    const compilationCount = compile.mock.calls.length
    expect(retrieval.recent(scope()).sessions.find((row) => row.id === 2)?.title).toBe(
      'fresh title'
    )
    expect(compile).toHaveBeenCalledTimes(compilationCount)
  })

  it('reuses batched text-match session loads and preserves every stored field', async () => {
    const retrieval = await seededRetrieval()
    if (!harness) {
      throw new Error('Missing search harness')
    }
    const expected = harness.db.prepare('SELECT * FROM sessions ORDER BY id').all()
    const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')

    for (let call = 0; call < 5; call += 1) {
      const result = retrieval.run(planSessionSearchQuery('needle'), scope())
      expect(result.sessions.toSorted((left, right) => left.id - right.id)).toEqual(expected)
      expect(result.rows).toHaveLength(513)
      expect(result.incomplete).toBe(false)
      expect(result.route).toBe('or')
    }

    expect(compile).toHaveBeenCalledTimes(3)
    expect(new Set(compile.mock.calls.map(([sql]) => sql)).size).toBe(3)
  })
})
