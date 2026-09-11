import { afterEach, describe, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { identifierShadowText } from './session-search-identifier-split'
import { readIndexGeneration } from './session-search-index-generation'
import { planSessionSearchQuery } from './session-search-query-planner'
import { sessionSearchSnippet } from './session-search-snippet'
import type { SessionSearchCursorError } from './session-search-page-cursor'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

// Retention deletes a session row in one small transaction and reclaims its
// message rows in batches afterwards, so a `messages` row with no `sessions` row
// is a state every purge, every removed source and every interrupted drain
// passes through. Those rows are still in both FTS tables and still in the
// vocabulary, and nothing here may return one.
//
// A hit is a session row, and the ranked list is loaded `FROM sessions`, so the
// route ladder below cannot surface an orphan even if a join were loosened —
// those cases are a ratchet over the shape, not the proof. The two reads that
// can leak one are pinned separately and each is a real oracle: the snippet,
// which is handed a rowid and asked for its text, and the typo repair, whose
// dictionary is the FTS b-tree and lists an orphan's terms like any other.

const ORPHAN_SESSION_ROW = 99
const ORPHAN_TEXT = 'orphaned marmoset secret'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

/** Two rows in the FTS table and the vocabulary, and no session row for them. */
function plantOrphans(db: SyncDatabase, text: string = ORPHAN_TEXT): number[] {
  const rowids: number[] = []
  for (let n = 0; n < 2; n++) {
    const rowid = Number(
      db
        .prepare("INSERT INTO messages(session_row_id,role,ts) VALUES (?,'user',?)")
        .run(ORPHAN_SESSION_ROW, '2026-09-10T00:00:00.000Z').lastInsertRowid
    )
    db.prepare(
      'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
    ).run(rowid, text, '', '', identifierShadowText(text))
    rowids.push(rowid)
  }
  return rowids
}

async function withOrphans(): Promise<{ harness: SessionSearchHarness; rowids: number[] }> {
  harness = await openSessionSearchHarness('ss-orphan-rows')
  addSyntheticSession(harness.db, { id: 1, text: 'the haystack line here' })
  const rowids = plantOrphans(harness.db)
  // The oracle only means anything if the rows are really there to be found.
  expect(
    harness.db
      .prepare("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'marmoset'")
      .get()
  ).toEqual({ c: 2 })
  expect(
    harness.db.prepare("SELECT doc FROM messages_vocab WHERE term = 'marmoset'").get()
  ).toEqual({ doc: 2 })
  return { harness, rowids }
}

it.each([
  ['phrase', '"orphaned marmoset"'],
  ['and', 'orphaned secret'],
  ['single-token literal', 'marmoset'],
  ['or', 'marmoset haystack orphaned'],
  ['typo repair', 'marmosett'],
  ['operator only', 'repo:app']
])('returns no orphaned row on the %s route', async (_route, query) => {
  const { harness: open } = await withOrphans()
  for (const scope of ['all', 'conversation'] as const) {
    const hits = open.engine.search({ query, scope }).hits
    expect(hits.map((hit) => hit.sessionId)).not.toContain(String(ORPHAN_SESSION_ROW))
    expect(hits.filter((hit) => hit.evidence?.snippet.includes('marmoset'))).toEqual([])
  }
})

it('never repairs a term onto a spelling only orphaned rows carry', async () => {
  const { harness: open } = await withOrphans()
  // `marmoset` is in the vocabulary twice, which is what would make it the
  // repair for `marmosett` if the repair trusted the vocabulary alone.
  expect(new SessionSearchTypoRepair(open.db).correct('marmosett', 'all')).toBeNull()
  expect(open.engine.search({ query: 'marmosett' }).planner.repairedTerms).toBeUndefined()
})

it('snippets nothing for an orphaned row, even asked for it by rowid', async () => {
  const { harness: open, rowids } = await withOrphans()
  const plan = planSessionSearchQuery('marmoset')
  for (const scope of ['all', 'conversation'] as const) {
    expect(sessionSearchSnippet(open.db, scope, rowids[0]!, plan)).toEqual({
      text: '',
      truncated: false
    })
  }
})

it('still answers for the live session beside them', async () => {
  const { harness: open } = await withOrphans()
  expect(open.engine.search({ query: 'haystack' }).hits.map((hit) => hit.sessionId)).toEqual(['1'])
})

// Reclaiming those rows is the other half. The drain deletes only from
// `messages`, so for a long time it was argued to change no answer and left
// outside the generation fence. Retrieval never saw them, but the typo repair's
// dictionary is `messages_vocab`, a view over the FTS b-tree that lists a term
// whether or not a reader can reach the rows carrying it — so the drain moved
// which word a query was repaired to, under a cursor that was still honoured.
describe('a purge reclaiming rows nothing can reach', () => {
  /** A live session and a purged one that both carry `text`. */
  async function withReclaimable(): Promise<SessionSearchHarness> {
    harness = await openSessionSearchHarness('ss-orphan-drain')
    // Two live rows, which is what makes `marmoset` eligible as a repair at all.
    addSyntheticSession(harness.db, { id: 1, text: 'the marmoset lives here', rows: 2 })
    plantOrphans(harness.db)
    return harness
  }

  it('answers the same before and after, because the repair counts live rows', async () => {
    const open = await withReclaimable()
    const before = open.engine.search({ query: 'marmosett' })
    expect(before.planner.repairedTerms).toEqual(['marmoset'])
    expect(before.hits.map((hit) => hit.sessionId)).toEqual(['1'])

    await open.store.purgeOlderThan(null)
    expect(open.db.prepare('SELECT count(*) AS c FROM messages').get()).toEqual({ c: 2 })

    const after = open.engine.search({ query: 'marmosett' })
    expect(after.planner.repairedTerms).toEqual(before.planner.repairedTerms)
    expect(after.hits.map((hit) => hit.sessionId)).toEqual(before.hits.map((hit) => hit.sessionId))
  })

  it('moves the generation anyway, so no cursor spans it', async () => {
    // The repair counting live rows fixes the common case. It does not make the
    // drain provably inert: `messages_vocab` still decides which candidates
    // survive its scan limit, and reclaiming a term's last row changes where
    // that limit cuts. The fence is what covers the rest, at the price of
    // refusing a cursor once per batch while a purge runs.
    const open = await withReclaimable()
    // A second live session, so page one has a page two to be refused.
    addSyntheticSession(open.db, { id: 2, text: 'the marmoset again', rows: 2 })
    const page = open.engine.search({ query: 'marmoset', limit: 1 })
    expect(page.page.cursor).not.toBeNull()
    const before = readIndexGeneration(open.db)

    await open.store.purgeOlderThan(null)

    expect(readIndexGeneration(open.db)).toBeGreaterThan(before)
    try {
      open.engine.search({ query: 'marmoset', limit: 1, cursor: page.page.cursor! })
      expect.unreachable('a cursor must not span a purge')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('stale-generation')
    }
  })

  it('picks the same repair when an unreachable spelling was the more common one', async () => {
    // Two candidates equally close to the query. `marmosetx` led on the old
    // ranking only because two of its rows belonged to a session retention had
    // already cut loose, so the drain swapped the repair under a live cursor.
    harness = await openSessionSearchHarness('ss-orphan-drain-tie')
    const db = harness.db
    for (let id = 1; id <= 4; id++) {
      addSyntheticSession(db, { id, text: `marmosetx session${id}` })
    }
    for (let id = 5; id <= 9; id++) {
      addSyntheticSession(db, { id, text: `marmosetq session${id}` })
    }
    plantOrphans(db, 'marmosetx')

    const before = harness.engine.search({ query: 'marmosett' })
    expect(before.planner.repairedTerms).toEqual(['marmosetq'])
    await harness.store.purgeOlderThan(null)
    expect(harness.engine.search({ query: 'marmosett' }).planner.repairedTerms).toEqual(
      before.planner.repairedTerms
    )
  })
})
