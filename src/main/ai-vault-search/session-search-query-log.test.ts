import { afterEach, expect, it } from 'vitest'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { logSessionSearchQuery } from './session-search-query-log'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

async function open(options = {}): Promise<SessionSearchHarness> {
  harness = await openSessionSearchHarness('ss-query-log', options)
  addSyntheticSession(harness.db, { id: 1, text: 'needle' })
  return harness
}

function loggedQueries(harness: SessionSearchHarness): string[] {
  return (
    harness.db.prepare('SELECT query FROM search_log ORDER BY id').all() as { query: string }[]
  ).map((row) => row.query)
}

it('writes nothing on the query path unless the caller asked for a log', async () => {
  const opened = await open()
  opened.engine.search({ query: 'needle' })
  expect(loggedQueries(opened)).toEqual([])
})

it('records the query and its route when logging is on', async () => {
  const opened = await open({ logQueries: true })
  opened.engine.search({ query: 'needle' })
  const rows = opened.db.prepare('SELECT query, route, hits FROM search_log').all() as {
    query: string
    route: string
    hits: number
  }[]
  expect(rows).toEqual([{ query: 'needle', route: 'or', hits: 1 }])
})

it('stores the query as typed, the way the index stores content as written', async () => {
  // PR 2 decided the index does not redact: it is a second copy of plaintext
  // the user already holds under their own home directory. The same holds for
  // what they typed into the search box.
  const opened = await open({ logQueries: true })
  opened.engine.search({ query: 'Bearer abcdefghijklmnopqrstuvwxyz012345' })
  expect(loggedQueries(opened)[0]).toBe('Bearer abcdefghijklmnopqrstuvwxyz012345')
})

it('keeps the newest N and drops the rest, so the log cannot grow with use', async () => {
  const opened = await open()
  // The real ceiling is 5,000; the trim is the same statement at any size.
  for (let n = 0; n < 12; n++) {
    logSessionSearchQuery(opened.db, { query: `q${n}`, route: 'or', hits: 0, durationMs: 1 }, 5)
  }
  expect(loggedQueries(opened)).toEqual(['q7', 'q8', 'q9', 'q10', 'q11'])
})
