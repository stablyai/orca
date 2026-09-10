import { afterEach, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { identifierShadowText } from './session-search-identifier-split'
import { planSessionSearchQuery } from './session-search-query-planner'
import { sessionSearchSnippet } from './session-search-snippet'
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

/** Two rows in both FTS tables and the vocabulary, and no session row for them. */
function plantOrphans(db: SyncDatabase): number[] {
  const rowids: number[] = []
  for (let n = 0; n < 2; n++) {
    const rowid = Number(
      db
        .prepare("INSERT INTO messages(session_row_id,role,ts) VALUES (?,'user',?)")
        .run(ORPHAN_SESSION_ROW, '2026-09-10T00:00:00.000Z').lastInsertRowid
    )
    db.prepare(
      'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
    ).run(rowid, ORPHAN_TEXT, '', '', identifierShadowText(ORPHAN_TEXT))
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
  expect(new SessionSearchTypoRepair(open.db).correct('marmosett')).toBeNull()
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
