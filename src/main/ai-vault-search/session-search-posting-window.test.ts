import { expect, it } from 'vitest'
import { addSyntheticSession, openSessionSearchHarness } from './session-search-engine-test-fixture'

it('freezes the newest index window before ranking and pages its truncated result once', async () => {
  const index = await openSessionSearchHarness('ss-posting-window')
  try {
    index.db.exec('BEGIN')
    for (let id = 1; id <= 12; id++) {
      addSyntheticSession(index.db, {
        id,
        text: 'windowword',
        rows: 1000,
        updatedAt: `2026-09-${String(20 - id).padStart(2, '0')}T00:00:00.000Z`
      })
    }
    index.db.exec('COMMIT')
    const request = { query: 'windowword', limit: 1 }
    const first = index.engine.search(request)
    expect(first.hits.map((hit) => hit.sessionId)).toEqual(['11'])
    expect(first.truncated.candidates).toBe(true)
    expect(first.page.hasMore).toBe(true)
    const next = index.engine.search({ ...request, cursor: first.page.cursor! })
    expect(next.hits.map((hit) => hit.sessionId)).toEqual(['12'])
    expect(next.truncated.candidates).toBe(true)
    expect(next.page).toEqual({ cursor: null, hasMore: false })
  } finally {
    await index.close()
  }
})

it('charges tool postings to scan work but leaves all candidate slots for conversations', async () => {
  const index = await openSessionSearchHarness('ss-posting-tools')
  try {
    index.db.exec('BEGIN')
    addSyntheticSession(index.db, { id: 1, text: 'crowded', rows: 1000 })
    addSyntheticSession(index.db, { id: 2, text: 'crowded', rows: 2000 })
    addSyntheticSession(index.db, { id: 3, text: 'crowded', role: 'tool', rows: 8500 })
    index.db.exec('COMMIT')
    const result = index.engine.search({ query: 'crowded' })
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['2'])
    expect(result.truncated.candidates).toBe(true)
    const filtered = index.engine.search({ query: 'crowded repo:absent' })
    expect(filtered.hits).toEqual([])
    expect(filtered.truncated.candidates).toBe(true)
  } finally {
    await index.close()
  }
})

it('shares examined postings across phrase and AND without rewalking filtered matches', async () => {
  const index = await openSessionSearchHarness('ss-posting-routes')
  try {
    index.db.exec('BEGIN')
    addSyntheticSession(index.db, { id: 1, text: 'alpha x beta', rows: 2 })
    addSyntheticSession(index.db, { id: 2, text: 'alpha beta', role: 'tool', rows: 6000 })
    index.db.exec('COMMIT')
    const result = index.engine.search({ query: '"alpha beta"' })
    expect(result.hits).toEqual([])
    expect(result.truncated.candidates).toBe(true)
  } finally {
    await index.close()
  }
})

it('keeps an inconclusive own spelling and reports even an empty budget-limited result', async () => {
  const index = await openSessionSearchHarness('ss-posting-own-term')
  try {
    index.db.exec('BEGIN')
    addSyntheticSession(index.db, { id: 1, text: 'coalesces', rows: 2 })
    addSyntheticSession(index.db, { id: 2, text: 'coalesce', rows: 2 })
    addSyntheticSession(index.db, { id: 3, text: 'coalesces', role: 'tool', rows: 10001 })
    index.db.exec('COMMIT')
    const result = index.engine.search({ query: 'coalesces' })
    expect(result.planner.repairedTerms).toBeUndefined()
    expect(result.hits).toEqual([])
    expect(result.truncated.candidates).toBe(true)
  } finally {
    await index.close()
  }
})

it('keeps capitalized hits when the spelling probe and OR share a crowded window', async () => {
  const index = await openSessionSearchHarness('ss-posting-capitalized')
  try {
    index.db.exec('BEGIN')
    addSyntheticSession(index.db, { id: 1, text: 'Timeout' })
    addSyntheticSession(index.db, { id: 2, text: 'Timeout', rows: 64 })
    addSyntheticSession(index.db, { id: 3, text: 'Timeout', role: 'tool', rows: 5000 })
    index.db.exec('COMMIT')
    for (const query of ['Timeout', 'TIMEOUT']) {
      const result = index.engine.search({ query })
      expect(result.hits.map((hit) => hit.sessionId).sort()).toEqual(['1', '2'])
      expect(result.truncated.candidates).toBe(false)
    }
  } finally {
    await index.close()
  }
})

it('keeps original OR hits beside a misspelling and crowded tool vocabulary', async () => {
  const index = await openSessionSearchHarness('ss-posting-vocabulary')
  try {
    index.db.exec('BEGIN')
    addSyntheticSession(index.db, { id: 1, text: 'deploy', rows: 2 })
    addSyntheticSession(index.db, { id: 2, text: 'request', role: 'tool', rows: 10001 })
    index.db.exec('COMMIT')
    const result = index.engine.search({ query: 'recieve deploy' })
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
    expect(result.planner.route).toBe('or')
    expect(result.planner.repairedTerms).toBeUndefined()
  } finally {
    await index.close()
  }
})

it('repairs a common spelling without spending postings on its vocabulary occurrences', async () => {
  const index = await openSessionSearchHarness('ss-posting-common-repair')
  try {
    index.db.exec('BEGIN')
    addSyntheticSession(index.db, { id: 1, text: 'coalesces', rows: 10001 })
    addSyntheticSession(index.db, { id: 2, text: 'terminal', rows: 2 })
    index.db.exec('COMMIT')
    const single = index.engine.search({ query: 'coalescs' })
    expect(single.planner.repairedTerms).toEqual(['coalesces'])
    expect(single.hits.map((hit) => hit.sessionId)).toEqual(['1'])
    const mixed = index.engine.search({ query: 'coalescs terminal' })
    expect(mixed.planner.repairedTerms).toEqual(['coalesces', 'terminal'])
    expect(mixed.hits.map((hit) => hit.sessionId).sort()).toEqual(['1', '2'])
  } finally {
    await index.close()
  }
})

it('keeps original hits and truncation when the shared vocabulary seek allowance runs out', async () => {
  const index = await openSessionSearchHarness('ss-posting-vocabulary-limit')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'deploy' })
    addSyntheticSession(index.db, {
      id: 2,
      text: Array.from({ length: 4001 }, (_, n) => `aa${String(n).padStart(5, '0')}`).join(' '),
      role: 'tool'
    })
    const result = index.engine.search({ query: 'aargh deploy' })
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
    expect(result.planner.route).toBe('or')
    expect(result.planner.repairedTerms).toBeUndefined()
    expect(result.truncated.candidates).toBe(true)
  } finally {
    await index.close()
  }
})

it('seeks past a whole vocabulary term while retaining its extensions', async () => {
  const index = await openSessionSearchHarness('ss-posting-vocabulary-successor')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'coalesce coalesces coalescing', rows: 2 })
    const seek = index.db.prepare(
      'SELECT term FROM temp.session_search_vocab WHERE term >= ? ORDER BY term LIMIT 1'
    )
    expect(seek.get('coal')).toEqual({ term: 'coalesce' })
    expect(seek.get('coalesce\u0000')).toEqual({ term: 'coalesces' })
    expect(seek.get('coalesces\u0000')).toEqual({ term: 'coalescing' })
    expect(seek.get('coalescing\u0000')).toBeUndefined()
    const result = index.engine.search({ query: 'coalescs' })
    expect(result.planner.repairedTerms).toEqual(['coalesces'])
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
  } finally {
    await index.close()
  }
})
