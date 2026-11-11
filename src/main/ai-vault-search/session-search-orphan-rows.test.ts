import { afterEach, describe, expect, it } from 'vitest'
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

// Purges leave orphaned FTS rows until reclamation; retrieval, snippets and typo repair must exclude them.

const ORPHAN_SESSION_ROW = 99
const ORPHAN_TEXT = 'orphaned marmoset secret'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

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
  // Vocabulary alone would propose marmoset, but its occurrences are all orphaned.
  expect(new SessionSearchTypoRepair(open.db).correct('marmosett', 'all')).toBeNull()
  expect(open.engine.search({ query: 'marmosett' }).planner.repairedTerms).toBeUndefined()
})

it('snippets nothing for an orphaned row, even asked for it by rowid', async () => {
  const { harness: open, rowids } = await withOrphans()
  const plan = planSessionSearchQuery('marmoset')
  for (const scope of ['all', 'conversation'] as const) {
    expect(sessionSearchSnippet(open.db, scope, rowids[0]!, plan, 'or')).toEqual({
      text: '',
      truncated: false
    })
  }
})

describe('a purge reclaiming rows nothing can reach', () => {
  it('picks the same repair when an unreachable spelling was the more common one', async () => {
    // Add orphaned occurrences to the less common live spelling to test that repair ranks only live rows.
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
