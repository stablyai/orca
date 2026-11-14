import { afterEach, describe, expect, it } from 'vitest'
import '../../../shared/ai-vault/search/ai-vault-search-contract'
import type { SessionSearchResponse } from './session-search-engine-types'

import './session-search-query-planner'
import './session-search-snippet'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

async function open(name: string, options = {}): Promise<SessionSearchHarness> {
  harness = await openSessionSearchHarness(name, options)
  return harness
}

function ids(result: SessionSearchResponse): string[] {
  return result.hits.map((hit) => hit.sessionId)
}

describe('the conversation scope is a column filter, and it binds the whole query', () => {
  it('refuses an AND whose second term lives only in tool output', async () => {
    // Parenthesize the whole FTS expression so its column filter applies to every term.
    const { db, engine } = await open('ss-engine-scope-binding')
    addSyntheticSession(db, { id: 1, text: 'alpha gamma beta' })
    addSyntheticSession(db, { id: 2, text: 'alpha gamma', toolText: 'beta' })
    // Literal nonadjacent terms force the AND fallback.
    const query = '"alpha" beta'

    const wide = engine.search({ query, scope: 'all' })
    expect(wide.planner.route).toBe('and')
    expect(ids(wide).sort()).toEqual(['1', '2'])

    const narrowed = engine.search({ query, scope: 'conversation' })
    expect(narrowed.planner.route).toBe('and')
    expect(ids(narrowed)).toEqual(['1'])
  })
})

describe('a session is one hit, however many of its rows matched', () => {
  it.each(['relevance', 'newest'] as const)(
    'keeps a short session on the %s page beside a 650-row session',
    async (sort) => {
      const { db, engine } = await open('ss-engine-aggregate', { sessionCandidateLimit: 600 })
      addSyntheticSession(db, { id: 1, rows: 650, updatedAt: '2026-09-06T00:00:00.000Z' })
      addSyntheticSession(db, {
        id: 2,
        text: 'needle padding',
        updatedAt: '2026-09-05T00:00:00.000Z'
      })
      expect(ids(engine.search({ query: 'needle', filters: { sort } })).sort()).toEqual(['1', '2'])
    }
  )
})

describe('filters narrow retrieval, not just the page', () => {
  it('finds a scoped match behind 600 out-of-scope rows', async () => {
    const { db, engine } = await open('ss-engine-scoped')
    addSyntheticSession(db, { id: 1, cwd: '/unrelated', rows: 600 })
    addSyntheticSession(db, { id: 2, cwd: '/target', text: 'needle padding' })
    expect(ids(engine.search({ query: 'needle', filters: { scopePaths: ['/target'] } }))).toEqual([
      '2'
    ])
  })
})

describe('evidence', () => {
  it('takes each snippet from that hit’s own best message', async () => {
    const { db, engine } = await open('ss-engine-snippet')
    // A missing rowid constraint would return this first row for every snippet.
    addSyntheticSession(db, {
      id: 1,
      text: 'hydration marmoset appears once in a long paragraph about routing and caching',
      updatedAt: '2026-09-01T00:00:00.000Z'
    })
    addSyntheticSession(db, {
      id: 2,
      text: 'hydration capybara',
      updatedAt: '2026-09-09T00:00:00.000Z'
    })
    const hits = engine.search({ query: 'hydration' }).hits
    expect(hits[0]?.evidence?.snippet).toContain('capybara')
    expect(hits[0]?.evidence?.snippet).not.toContain('marmoset')
    expect(hits.find((hit) => hit.sessionId === '1')?.evidence?.snippet).toContain('marmoset')
  })
})

it.each(['repo:target', 'path:/work/target'])(
  'applies %s before selecting a route',
  async (operator) => {
    const { db, engine } = await open('ss-route-filter')
    addSyntheticSession(db, { id: 1, cwd: '/work/other', text: 'alpha beta' })
    addSyntheticSession(db, { id: 2, cwd: '/work/target', text: 'alpha x beta' })
    const result = engine.search({ query: `"alpha beta" ${operator}` })
    expect(ids(result)).toEqual(['2'])
    expect(result.planner.route).toBe('and')
    expect(result.truncated.candidates).toBe(false)
  }
)

describe('a sentence pasted out of a transcript is found behind a full candidate set', () => {
  // Common OR terms can fill the candidate cap before an older exact sentence reaches ranking.
  const sentence = 'The sol review says the PR is not quite merge-ready yet'

  async function pasted(sessionCandidateLimit = 600): Promise<SessionSearchHarness> {
    const opened = await open('ss-engine-pasted-sentence', { sessionCandidateLimit })
    addSyntheticSession(opened.db, {
      id: 1,
      text: `${sentence}, but not because of the implementation.`,
      updatedAt: '2026-08-01T00:00:00.000Z'
    })
    for (let id = 2; id <= sessionCandidateLimit + 50; id++) {
      addSyntheticSession(opened.db, {
        id,
        text: 'the review says the implementation is not quite there yet',
        updatedAt: '2026-09-09T00:00:00.000Z'
      })
    }
    return opened
  }

  it('returns the exact sentence first, over the phrase route', async () => {
    const { engine } = await pasted()
    const result = engine.search({ query: sentence })
    expect(result.planner.route).toBe('phrase')
    expect(ids(result)).toEqual(['1'])
  })
})
