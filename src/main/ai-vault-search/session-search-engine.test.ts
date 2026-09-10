import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_SEARCH_QUERY_MAX_LENGTH } from './session-search-engine-types'
import type { SessionSearchRequest, SessionSearchResponse } from './session-search-engine-types'
import { planSessionSearchQuery } from './session-search-query-planner'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import { EMPTY_SNIPPET, sessionSearchSnippet } from './session-search-snippet'
import {
  addSyntheticSession,
  markFork,
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

describe('the route ladder tries phrase, then AND, then repair, then OR', () => {
  async function routeFor(
    text: string,
    request: SessionSearchRequest
  ): Promise<SessionSearchResponse> {
    const { db, engine } = await open('ss-engine-route')
    addSyntheticSession(db, { id: 1, text })
    return engine.search(request)
  }

  it('takes the phrase route when the tokens are adjacent and in order', async () => {
    const result = await routeFor('the alpha beta gamma line', { query: '"alpha beta"' })
    expect(result.planner.route).toBe('phrase')
    expect(ids(result)).toEqual(['1'])
  })

  it('falls to AND when the tokens are present but not adjacent', async () => {
    const result = await routeFor('beta separated alpha', { query: '"alpha beta"' })
    expect(result.planner.route).toBe('and')
    expect(ids(result)).toEqual(['1'])
  })

  it('falls to OR for prose, where no phrase was ever claimed', async () => {
    const result = await routeFor('the relay dropped a frame', { query: 'relay frames dropped' })
    expect(result.planner.route).toBe('or')
    expect(ids(result)).toEqual(['1'])
  })

  it('repairs a typo before the OR fallback, and says which terms it changed', async () => {
    const { db, engine } = await open('ss-engine-typo')
    // Two copies: the repair only suggests a term the index really holds.
    addSyntheticSession(db, { id: 1, text: 'the coalesces path is slow' })
    addSyntheticSession(db, { id: 2, text: 'coalesces again here' })
    const result = engine.search({ query: 'coalescs' })
    expect(result.planner.route).toBe('typo+or')
    expect(result.planner.repairedTerms).toEqual(['coalesces'])
    expect(ids(result).sort()).toEqual(['1', '2'])
  })

  it('keeps every term a repaired literal was typed with', async () => {
    const { db, engine } = await open('ss-engine-typo-literal')
    addSyntheticSession(db, { id: 1, text: 'parseJson the data' })
    addSyntheticSession(db, { id: 2, text: 'parseJson the data again' })
    // `parseJsonn(the, data)` is literal because of its punctuation; the
    // corrected spelling read on its own is prose. Re-planning without carrying
    // the original decision across would drop `the` and report a body that was
    // never typed.
    // A corrected term comes back in the index's own spelling, which unicode61
    // has folded; the terms the repair left alone keep the case they were typed.
    const result = engine.search({ query: 'parseJsonn(the, data)' })
    expect(result.planner.repairedTerms).toEqual(['parsejson', 'the', 'data'])
  })

  it('does not repair a term the index already holds', async () => {
    const { db, engine } = await open('ss-engine-no-typo')
    addSyntheticSession(db, { id: 1, text: 'coalesces' })
    const result = engine.search({ query: 'coalesces' })
    expect(result.planner.repairedTerms).toBeUndefined()
    expect(result.planner.route).toBe('or')
  })

  it('reports the scope it searched as the planner tier', async () => {
    const { db, engine } = await open('ss-engine-tier')
    addSyntheticSession(db, { id: 1, text: 'needle' })
    expect(engine.search({ query: 'needle' }).planner.tier).toBe('all')
    expect(engine.search({ query: 'needle', scope: 'conversation' }).planner.tier).toBe(
      'conversation'
    )
  })
})

describe('scope picks the corpus and never switches it', () => {
  async function corpus(): Promise<SessionSearchHarness> {
    const opened = await open('ss-engine-scope')
    addSyntheticSession(opened.db, { id: 1, text: 'harbor pilot manifest', role: 'user' })
    addSyntheticSession(opened.db, { id: 2, text: 'harbor tool output line', role: 'tool' })
    return opened
  }

  it('searches conversation turns only under `conversation`', async () => {
    const { engine } = await corpus()
    expect(ids(engine.search({ query: 'harbor', scope: 'conversation' }))).toEqual(['1'])
  })

  it('includes tool output under `all`, which is the default', async () => {
    const { engine } = await corpus()
    expect(ids(engine.search({ query: 'harbor', scope: 'all' })).sort()).toEqual(['1', '2'])
    expect(ids(engine.search({ query: 'harbor' })).sort()).toEqual(['1', '2'])
  })

  it('returns nothing rather than widening when the narrow scope misses', async () => {
    // The panel's two-tier typing is a UI policy (PR 7). An engine that widened
    // here would make a result impossible to reproduce from its own request.
    const { engine } = await corpus()
    const result = engine.search({ query: 'output', scope: 'conversation' })
    expect(result.hits).toEqual([])
    expect(result.planner.tier).toBe('conversation')
  })

  it('matches an identifier through its pieces only in the full corpus', async () => {
    const { db, engine } = await open('ss-engine-identifiers')
    addSyntheticSession(db, { id: 1, text: 'resolveTerminalPath' })
    // The identifier shadow column lives in messages_fts alone.
    expect(ids(engine.search({ query: 'terminal path' }))).toEqual(['1'])
    expect(engine.search({ query: 'terminal path', scope: 'conversation' }).hits).toEqual([])
  })
})

describe('the conversation scope is a column filter, and it binds the whole query', () => {
  it('refuses an AND whose second term lives only in tool output', async () => {
    // The filter binds to the expression it prefixes. `{cols}: (a AND b)`
    // filters both terms; `{cols}: a AND b` filters only `a` and searches tool
    // output for the rest, which is a conversation search answering from a
    // column it promised not to read.
    const { db, engine } = await open('ss-engine-scope-binding')
    addSyntheticSession(db, { id: 1, text: 'alpha gamma beta' })
    addSyntheticSession(db, { id: 2, text: 'alpha gamma', toolText: 'beta' })
    // Quoted, so the query is literal; not adjacent, so the phrase rung misses
    // and the AND rung is the one that answers.
    const query = '"alpha" beta'

    const wide = engine.search({ query, scope: 'all' })
    expect(wide.planner.route).toBe('and')
    expect(ids(wide).sort()).toEqual(['1', '2'])

    const narrowed = engine.search({ query, scope: 'conversation' })
    expect(narrowed.planner.route).toBe('and')
    expect(ids(narrowed)).toEqual(['1'])
  })

  it('ranks a conversation hit down for tool output it will not show', async () => {
    // The one behavioural difference the column filter carries, pinned rather
    // than wished away. FTS5's bm25 normalises by the whole row's length and
    // has no per-column length, so two rows with identical prose do not score
    // identically when one of them also holds tool output. A dedicated
    // two-column table scored them the same. The rowid set is unchanged, which
    // is what the decision was measured on; the order within it can move.
    const { db, engine } = await open('ss-engine-scope-weights')
    addSyntheticSession(db, { id: 1, text: 'harbor pilot' })
    addSyntheticSession(db, { id: 2, text: 'harbor pilot', toolText: 'unrelated '.repeat(40) })
    const narrowed = engine.search({ query: 'harbor', scope: 'conversation' })
    expect(ids(narrowed)).toEqual(['1', '2'])
    expect(narrowed.hits[0]!.score).toBeGreaterThan(narrowed.hits[1]!.score)
  })

  it('never snippets a conversation hit out of tool output', async () => {
    const { db, engine } = await open('ss-engine-scope-snippet')
    addSyntheticSession(db, { id: 1, text: 'harbor pilot', toolText: 'harbor tool output line' })
    const [hit] = engine.search({ query: 'harbor', scope: 'conversation' }).hits
    expect(hit?.evidence?.snippet).toContain('pilot')
    expect(hit?.evidence?.snippet).not.toContain('output')
    // And asked for a tool-only row directly, it has nothing to show.
    addSyntheticSession(db, { id: 2, text: 'harbor tool output line', role: 'tool' })
    const rowid = Number(
      (db.prepare('SELECT max(id) AS id FROM messages').get() as { id: number }).id
    )
    const plan = planSessionSearchQuery('harbor')
    expect(sessionSearchSnippet(db, 'conversation', rowid, plan)).toEqual(EMPTY_SNIPPET)
    expect(sessionSearchSnippet(db, 'all', rowid, plan).text).toContain('output')
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
      // Collapsing to one row per session happens before the candidate limit,
      // so the 650-row session cannot crowd the one-row session off the page on
      // either order; which of them ranks first is the sort's business.
      expect(ids(engine.search({ query: 'needle', filters: { sort } })).sort()).toEqual(['1', '2'])
    }
  )

  it('folds forks the same way for an operator-only page as for a text page', async () => {
    const { db, engine } = await open('ss-engine-forks')
    for (const id of [1, 2, 3, 4]) {
      addSyntheticSession(db, { id, updatedAt: `2026-09-0${id}T00:00:00.000Z` })
    }
    markFork(db, [1, 2, 3, 4], 'shared-fork-prefix')
    const operatorOnly = engine.search({ query: 'repo:app' })
    const withText = engine.search({ query: 'needle repo:app' })
    expect(ids(operatorOnly)).toEqual(['4'])
    expect(operatorOnly.hits[0]?.duplicateCount).toBe(4)
    expect(ids(withText)).toEqual(ids(operatorOnly))
    expect(withText.hits[0]?.duplicateCount).toBe(4)
  })

  it('answers an operator-only query with the newest sessions and no evidence', async () => {
    const { db, engine } = await open('ss-engine-operator-only')
    addSyntheticSession(db, { id: 1, updatedAt: '2026-09-01T00:00:00.000Z' })
    addSyntheticSession(db, { id: 2, updatedAt: '2026-09-09T00:00:00.000Z' })
    const result = engine.search({ query: 'repo:app' })
    expect(ids(result)).toEqual(['2', '1'])
    expect(result.hits[0]?.evidence).toBeNull()
  })

  it('has no hits for a query with neither text nor operators', async () => {
    const { db, engine } = await open('ss-engine-empty')
    addSyntheticSession(db, { id: 1 })
    expect(engine.search({ query: '   ' }).hits).toEqual([])
  })
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

  it('falls back to a later rung when the exact hit is out of scope', async () => {
    const { db, engine } = await open('ss-engine-scoped-route')
    addSyntheticSession(db, { id: 1, cwd: '/unrelated', text: 'resolveTerminalPath' })
    addSyntheticSession(db, { id: 2, cwd: '/target', text: 'resolve terminal path' })
    expect(
      ids(engine.search({ query: 'resolveTerminalPath', filters: { scopePaths: ['/target'] } }))
    ).toEqual(['2'])
  })
})

describe('evidence', () => {
  it('takes each snippet from that hit’s own best message', async () => {
    const { db, engine } = await open('ss-engine-snippet')
    // Written first, so its row owns the lowest rowid: the row a dropped rowid
    // constraint would hand back for every hit.
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

  it('shows the prose column rather than the identifier shadow when both match', async () => {
    const { db, engine } = await open('ss-engine-snippet-shadow')
    addSyntheticSession(db, {
      id: 1,
      text: 'resolveTerminalPath is broken and the terminal never comes up for a pane, which is odd because every other pane on this host resolves its path'
    })
    const snippet = engine.search({ query: 'terminal path' }).hits[0]?.evidence?.snippet ?? ''
    expect(snippet).toContain('[[')
    expect(snippet).not.toContain('resolve [[terminal]] [[path]]')
  })

  it('flags a snippet it had to cut, and counts it on the result', async () => {
    const { db, engine } = await open('ss-engine-snippet-truncated')
    // The window is twelve tokens wide, and one of them is 4000 characters, so
    // the token count is no bound at all on what a hit carries.
    addSyntheticSession(db, { id: 1, text: `needle ${'x'.repeat(4000)}` })
    const result = engine.search({ query: 'needle' })
    expect(result.hits[0]?.evidence?.snippetTruncated).toBe(true)
    expect(result.hits[0]?.evidence?.snippet.length).toBeLessThan(600)
    expect(result.truncated.snippets).toBe(1)
  })

  it('leaves an ordinary snippet unflagged', async () => {
    const { db, engine } = await open('ss-engine-snippet-whole')
    addSyntheticSession(db, { id: 1, text: 'needle in a short line' })
    const result = engine.search({ query: 'needle' })
    expect(result.hits[0]?.evidence?.snippetTruncated).toBeUndefined()
    expect(result.truncated.snippets).toBe(0)
  })
})

describe('source presence comes from the files table, never a stat', () => {
  it('calls a session with a live file record present', async () => {
    const { db, engine } = await open('ss-engine-presence')
    addSyntheticSession(db, { id: 1 })
    expect(engine.search({ query: 'needle' }).hits[0]?.source).toBe('present')
  })

  it('calls a session with no file record unverifiable, and still returns it', async () => {
    // Loss of contact is never evidence of absence: the hit stays on the page.
    const { db, engine } = await open('ss-engine-presence-unknown')
    addSyntheticSession(db, { id: 1, filePath: null })
    const hits = engine.search({ query: 'needle' }).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe('unverifiable')
  })
})

describe('the engine carries its own schema and puts it back', () => {
  it('installs the vocabulary and the log over an index a writer built alone', async () => {
    // The store creates none of these: PR 3's indexer can fill a whole index
    // before anything opens an engine over it.
    const { db, engine } = await open('ss-engine-installs')
    addSyntheticSession(db, { id: 1, text: 'the coalesces path is slow' })
    addSyntheticSession(db, { id: 2, text: 'coalesces again here' })
    const result = engine.search({ query: 'coalescs' })
    expect(result.unavailable).toEqual([])
    expect(result.planner.route).toBe('typo+or')
    expect(ids(result).sort()).toEqual(['1', '2'])
  })

  it('re-creates a vocabulary that vanished under a live engine', async () => {
    const { db, engine } = await open('ss-engine-vocab-vanishes')
    addSyntheticSession(db, { id: 1, text: 'coalesces here now' })
    addSyntheticSession(db, { id: 2, text: 'coalesces again here' })
    expect(engine.search({ query: 'coalescs' }).planner.route).toBe('typo+or')

    db.exec('DROP TABLE messages_vocab')
    const after = engine.search({ query: 'coalescs' })
    expect(after.unavailable).toEqual([])
    expect(after.planner.route).toBe('typo+or')
  })

  it('names the feature it cannot serve when the vocabulary has no source left', async () => {
    // What an index being rebuilt by another handle looks like from here. The
    // vocabulary can be created over a missing `messages_fts` and every query
    // against it then fails, so the probe reads the source, not the view.
    //
    // With one FTS table there is no scope left to answer from, so this is now
    // the boundary of the degrade: the engine names the feature and the search
    // fails loudly on the table it cannot read, rather than returning an empty
    // page that looks like an answer.
    const { db, engine } = await open('ss-engine-vocab-source-gone')
    addSyntheticSession(db, { id: 1, text: 'coalesces here now', role: 'user' })
    db.exec('DROP TABLE messages_vocab; DROP TABLE messages_fts')

    expect(ensureSessionSearchQuerySchema(db)).toEqual(['typo-repair'])
    for (const scope of ['all', 'conversation'] as const) {
      expect(() => engine.search({ query: 'coalesces', scope })).toThrow(/no such (fts5 )?table/i)
    }
  })

  it('picks the feature back up when the source comes back', async () => {
    const { db, engine } = await open('ss-engine-vocab-returns')
    addSyntheticSession(db, { id: 1, text: 'coalesces here now' })
    addSyntheticSession(db, { id: 2, text: 'coalesces again here' })
    const fts = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").get() as {
        sql: string
      }
    ).sql
    db.exec('DROP TABLE messages_vocab; DROP TABLE messages_fts')
    expect(ensureSessionSearchQuerySchema(db)).toEqual(['typo-repair'])

    db.exec(fts)
    // Two, because the vocabulary only offers a term at least two rows carry.
    addSyntheticSession(db, { id: 3, text: 'coalesces one more time' })
    addSyntheticSession(db, { id: 4, text: 'coalesces once again' })
    // Nothing throws on the way back up, so the recovery cannot come from the
    // error path; it comes from the probe running per search.
    const restored = engine.search({ query: 'coalescs' })
    expect(restored.unavailable).toEqual([])
    expect(restored.planner.route).toBe('typo+or')
  })
})

describe('a query the engine had to cut says so', () => {
  it('cuts the query on a whole code point, never through a surrogate pair', async () => {
    // A bare slice at 512 can land between the two halves of an astral
    // character, and the lone half matches nothing and cannot be echoed back.
    const { db, engine } = await open('ss-engine-surrogate-cap')
    addSyntheticSession(db, { id: 1, text: 'needle' })
    const query = `${'x'.repeat(SESSION_SEARCH_QUERY_MAX_LENGTH - 1)}😀 needle`
    const result = engine.search({ query })
    expect(result.truncated.query).toBe(true)
    // The emoji straddles the cap, so the cut has to fall before it.
    expect(query.slice(0, SESSION_SEARCH_QUERY_MAX_LENGTH).at(-1)).toBe('\ud83d')
    expect(result.hits).toEqual([])
  })

  it('loads more candidate sessions than SQLite will bind in one statement', async () => {
    // The id list is as long as the candidate limit and every id is a bound
    // parameter, so one statement is a raised limit away from `too many SQL
    // variables` on a host whose SQLite caps at 999.
    const { db, engine } = await open('ss-engine-id-batching', {
      sessionCandidateLimit: 1200
    })
    for (let id = 1; id <= 1100; id++) {
      addSyntheticSession(db, { id, text: 'needle' })
    }
    const result = engine.search({ query: 'needle', limit: 5 })
    expect(result.hits).toHaveLength(5)
    expect(result.truncated.candidates).toBe(false)
  })

  it('reports truncation when the planner drops terms past its cap', async () => {
    // The 56th term is the only one that matches. Without the flag this is a
    // confident empty answer to a query the engine never finished reading.
    const { db, engine } = await open('ss-engine-term-cap')
    addSyntheticSession(db, { id: 1, text: 'onlyattheend' })
    const query = `${Array.from({ length: 55 }, (_unused, n) => `term${n}`).join(' ')} onlyattheend`
    const result = engine.search({ query })
    expect(result.hits).toEqual([])
    expect(result.truncated.query).toBe(true)
  })

  it('reports truncation when the query is longer than the engine will plan', async () => {
    const { db, engine } = await open('ss-engine-length-cap')
    addSyntheticSession(db, { id: 1, text: 'needle' })
    const result = engine.search({ query: `needle ${'x'.repeat(SESSION_SEARCH_QUERY_MAX_LENGTH)}` })
    expect(result.truncated.query).toBe(true)
  })

  it('claims no truncation for a query that fit', async () => {
    const { db, engine } = await open('ss-engine-no-cap')
    addSyntheticSession(db, { id: 1, text: 'needle' })
    expect(engine.search({ query: 'needle' }).truncated.query).toBe(false)
  })
})

describe('a query longer than the engine will plan is cut, not refused', () => {
  it('cuts one enormous token down to the cap before FTS5 ever sees it', async () => {
    const { db, engine } = await open('ss-engine-long-query')
    // The planner already caps how many terms it will plan, so a long query of
    // ordinary words is bounded without this. What is not bounded is a single
    // token: one 100 kB word is one term, and FTS5 would carry the whole thing
    // into the MATCH expression. The cut is observable because the indexed
    // token is exactly the capped length.
    addSyntheticSession(db, { id: 1, text: 'x'.repeat(SESSION_SEARCH_QUERY_MAX_LENGTH) })
    expect(ids(engine.search({ query: 'x'.repeat(4000) }))).toEqual(['1'])
  })
})

describe('unicode terms survive the round trip', () => {
  it.each(['café', 'C', 'R', 'x', '修復', '안녕하세요'])('searches %s', async (text) => {
    const { db, engine } = await open('ss-engine-unicode')
    addSyntheticSession(db, { id: 1, text })
    expect(engine.search({ query: text }).hits).toHaveLength(1)
  })
})
