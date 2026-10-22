import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import {
  eligibleSessionsKey,
  type AiVaultSearchEligibleSessions
} from '../../shared/ai-vault-search-eligible-sessions'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './session-search-engine'
import {
  addSyntheticSession,
  markFork,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { sessionSearchPageKey } from './session-search-page-cursor'

let harness: SessionSearchHarness | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})

function providers(...ids: string[]): AiVaultSearchEligibleSessions {
  return { providers: ids.map((sessionId) => ({ agent: 'claude', sessionId })), prompts: [] }
}

it('chooses phrase and AND routes inside eligibility, before the candidate cap', async () => {
  harness = await openSessionSearchHarness('ss-eligible-route', { sessionCandidateLimit: 1 })
  addSyntheticSession(harness.db, {
    id: 1,
    text: 'We fixed the token refresh race in a closed chat.'
  })
  addSyntheticSession(harness.db, {
    id: 2,
    text: 'An open chat: the token expires and refresh causes a race here.'
  })
  const request = { query: 'token refresh race' }
  expect(harness.engine.search(request).hits.map((hit) => hit.sessionId)).toEqual(['1'])
  const filtered = harness.engine.search({ ...request, eligibleSessions: providers('2') })
  expect(filtered.planner.route).toBe('and')
  expect(filtered.hits.map((hit) => hit.sessionId)).toEqual(['2'])
  expect(
    harness.engine.search({ ...request, eligibleSessions: providers('1') }).planner.route
  ).toBe('phrase')
})

it('excludes closed sessions before newest/relevance caps and fork folding', async () => {
  harness = await openSessionSearchHarness('ss-eligible-fold', { sessionCandidateLimit: 2 })
  for (let id = 1; id <= 5; id++) {
    addSyntheticSession(harness.db, {
      id,
      text: 'a needle here',
      updatedAt: `2026-09-0${id}T00:00:00Z`
    })
  }
  markFork(harness.db, [1, 5], 'same-opening')
  for (const sort of ['newest', 'relevance'] as const) {
    expect(
      harness.engine
        .search({ query: 'needle', filters: { sort }, eligibleSessions: providers('1', '2') })
        .hits.map((hit) => hit.sessionId)
    ).toEqual(['2', '1'])
  }
  expect(
    harness.engine
      .search({ query: 'repo:app', eligibleSessions: providers('1') })
      .hits.map((hit) => hit.sessionId)
  ).toEqual(['1'])
})

it('keeps agent identity exact and distinguishes absent from empty eligibility', async () => {
  harness = await openSessionSearchHarness('ss-eligible-identities')
  addSyntheticSession(harness.db, { id: 1, text: 'a needle here' })
  addSyntheticSession(harness.db, { id: 2, agent: 'codex', text: 'a needle here' })
  harness.db.prepare("UPDATE sessions SET session_id = 'same'").run()
  expect(
    harness.engine
      .search({ query: 'needle', eligibleSessions: providers('same') })
      .hits.map((hit) => hit.agent)
  ).toEqual(['claude'])
  expect(harness.engine.search({ query: 'needle', eligibleSessions: providers() }).hits).toEqual([])
  expect(harness.engine.search({ query: 'needle' }).hits).toHaveLength(2)
})

it('preserves eligible fork sessions when requested, including operator-only results and paging', async () => {
  harness = await openSessionSearchHarness('ss-eligible-open-forks')
  for (let id = 1; id <= 3; id++) {
    addSyntheticSession(harness.db, { id, text: 'a needle here', rows: id })
  }
  markFork(harness.db, [1, 2, 3], 'same-opening')
  const eligibleSessions = providers('1', '2')
  for (const query of ['needle', 'repo:app']) {
    const request = { query, eligibleSessions }
    expect(harness.engine.search(request).hits.map((hit) => hit.sessionId)).toEqual(['2'])
    expect(harness.engine.search({ query }).hits.map((hit) => hit.sessionId)).toEqual(['3'])
    const openTabs = harness.engine.search({ ...request, preserveForks: true })
    expect(openTabs.hits.map((hit) => hit.sessionId).sort()).toEqual(['1', '2'])
    expect(openTabs.hits.every((hit) => hit.duplicateCount === undefined)).toBe(true)
    const first = harness.engine.search({ ...request, preserveForks: true, limit: 1 })
    const cursor = first.page.cursor ?? undefined
    expect(cursor).toBeTruthy()
    const second = harness.engine.search({ ...request, preserveForks: true, limit: 1, cursor })
    expect(new Set([...first.hits, ...second.hits].map((hit) => hit.sessionId)).size).toBe(2)
    expect(() => harness!.engine.search({ ...request, cursor })).toThrow('different-query')
  }
})

it('makes typo visibility and repair decisions within eligible sessions', async () => {
  harness = await openSessionSearchHarness('ss-eligible-typos')
  addSyntheticSession(harness.db, { id: 1, text: 'a refersh token in the closed history here' })
  addSyntheticSession(harness.db, { id: 2, text: 'an open refresh token issue here' })
  addSyntheticSession(harness.db, { id: 3, text: 'an open refresh token issue here' })
  const filtered = harness.engine.search({
    query: 'refersh',
    eligibleSessions: providers('2', '3')
  })
  expect(filtered.planner.repairedTerms).toEqual(['refresh'])
  expect(filtered.hits.map((hit) => hit.sessionId).sort()).toEqual(['2', '3'])
  expect(harness.engine.search({ query: 'refersh' }).hits.map((hit) => hit.sessionId)).toEqual([
    '1'
  ])
})

it('preserves exact Unicode/whitespace prompt fallback and rejects ambiguous targets', async () => {
  harness = await openSessionSearchHarness('ss-eligible-prompts')
  addSyntheticSession(harness.db, { id: 1, text: 'a needle here' })
  harness.db
    .prepare('UPDATE sessions SET title = ? WHERE id = 1')
    .run('  RÉPAIR\n\tThis Particularly Long Conversation Title  ')
  const prompt = {
    agent: 'claude' as const,
    prompts: ['répair this particularly long conversation']
  }
  const eligibleSessions = { providers: [], prompts: [prompt] }
  expect(harness.engine.search({ query: 'needle', eligibleSessions }).hits).toHaveLength(1)
  expect(
    harness.engine.search({
      query: 'needle',
      eligibleSessions: { ...eligibleSessions, prompts: [prompt, prompt] }
    }).hits
  ).toEqual([])
  expect(
    harness.engine.search({
      query: 'needle',
      eligibleSessions: { ...providers('1'), prompts: [prompt, prompt] }
    }).hits
  ).toHaveLength(1)
})

it('keeps provider-only queries in SQL even with a large history and eligibility list', async () => {
  harness = await openSessionSearchHarness('ss-eligible-work')
  const register = harness.db.function.bind(harness.db)
  const scalar = vi.fn()
  vi.spyOn(harness.db, 'function').mockImplementation((name, callback) => {
    register(name, (agent, title) => {
      scalar()
      return callback(agent, title)
    })
  })
  const engine = new SessionSearchEngine(harness.db)
  for (let id = 1; id <= 300; id++) {
    addSyntheticSession(harness.db, { id, text: 'a needle here' })
  }
  const prepare = vi.spyOn(harness.db, 'prepare')
  const result = engine.search({
    query: 'needle',
    eligibleSessions: providers(
      '1',
      ...Array.from({ length: 2047 }, (_, index) => `absent-${index}`)
    )
  })
  expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
  expect(scalar).not.toHaveBeenCalled()
  expect(prepare.mock.calls.length).toBeLessThan(25)
})

it('binds cursors to eligibility while canonicalizing provider and prompt ordering', async () => {
  harness = await openSessionSearchHarness('ss-eligible-cursor')
  for (let id = 1; id <= 3; id++) {
    addSyntheticSession(harness.db, { id, text: 'a needle here' })
  }
  const request = { query: 'needle', limit: 1, eligibleSessions: providers('1', '2', '3') }
  const first = harness.engine.search(request)
  expect(first.page.cursor).toBeTruthy()
  expect(() =>
    harness!.engine.search({
      ...request,
      cursor: first.page.cursor ?? undefined,
      eligibleSessions: providers('1', '2')
    })
  ).toThrow('different-query')
  expect(sessionSearchPageKey(request)).toBe(
    sessionSearchPageKey({ ...request, eligibleSessions: providers('3', '2', '1', '1') })
  )
  expect(eligibleSessionsKey(undefined)).not.toBe(eligibleSessionsKey(providers()))
  const promptA = { agent: 'claude' as const, prompts: ['second', 'first', 'first'] }
  const promptB = { agent: 'claude' as const, prompts: ['first', 'second'] }
  expect(eligibleSessionsKey({ providers: [], prompts: [promptA] })).toBe(
    eligibleSessionsKey({ providers: [], prompts: [promptB] })
  )
  expect(eligibleSessionsKey({ providers: [], prompts: [promptA, promptB] })).not.toBe(
    eligibleSessionsKey({ providers: [], prompts: [promptB] })
  )
})

it('keeps the wire restriction optional, bounded, and intact across parsing', () => {
  expect(AiVaultSearchRequestSchema.parse({ query: 'needle' }).eligibleSessions).toBeUndefined()
  expect(
    AiVaultSearchRequestSchema.parse({ query: 'needle', eligibleSessions: providers('1') })
      .eligibleSessions
  ).toEqual(providers('1'))
  expect(
    AiVaultSearchRequestSchema.parse({
      query: 'needle',
      preserveForks: true,
      includeOriginalExcerpt: true
    })
  ).toMatchObject({ preserveForks: true, includeOriginalExcerpt: true })
  expect(
    AiVaultSearchRequestSchema.safeParse({
      query: 'needle',
      eligibleSessions: providers(...Array.from({ length: 2049 }, (_, index) => String(index)))
    }).success
  ).toBe(false)
})

it('evaluates legacy eligibility only on FTS-matched sessions, including typo visibility', async () => {
  const register = SyncDatabase.prototype.function
  const eligibility = vi.fn()
  vi.spyOn(SyncDatabase.prototype, 'function').mockImplementation(function (
    this: SyncDatabase,
    name,
    callback
  ) {
    register.call(this, name, (agent, title) => {
      eligibility()
      return callback(agent, title)
    })
  })
  harness = await openSessionSearchHarness('ss-legacy-scaling')
  const engine = harness.engine
  harness.db.exec('BEGIN')
  for (let id = 1; id <= 3000; id++) {
    addSyntheticSession(harness.db, {
      id,
      rows: id <= 2 ? 20 : 1,
      text: id <= 2 ? 'a raremarker refresh here' : 'ordinary history'
    })
    harness.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run(`Distinct task ${id}: Build a useful and complex feature`, id)
  }
  harness.db.exec('COMMIT')
  const eligibleSessions: AiVaultSearchEligibleSessions = {
    providers: [],
    prompts: Array.from({ length: 20 }, (_, pane) => ({
      agent: 'claude',
      prompts: Array.from(
        { length: 20 },
        (_, entry) => `Distinct task ${pane * 20 + entry + 1}: Build a useful and complex feature`
      )
    }))
  }
  for (const query of ['raremarker', 'refersh']) {
    eligibility.mockClear()
    expect(
      engine
        .search({ query, eligibleSessions })
        .hits.map((hit) => hit.sessionId)
        .sort()
    ).toEqual(['1', '2'])
    expect(eligibility.mock.calls.length).toBeGreaterThan(0)
    expect(eligibility.mock.calls.length).toBeLessThan(15)
  }
})

it('pages every distinct eligible provider beyond the archive candidate default', async () => {
  harness = await openSessionSearchHarness('ss-eligible-large-page')
  harness.db.exec('BEGIN')
  for (let id = 1; id <= 725; id++) {
    addSyntheticSession(harness.db, { id, text: 'a needle here' })
  }
  harness.db.exec('COMMIT')
  const request = {
    query: 'needle',
    limit: 100,
    preserveForks: true,
    eligibleSessions: providers(...Array.from({ length: 725 }, (_, index) => String(index + 1)))
  }
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = harness.engine.search({ ...request, cursor })
    ids.push(...page.hits.map((hit) => hit.sessionId))
    cursor = page.page.cursor ?? undefined
  } while (cursor)
  expect(ids).toHaveLength(725)
  expect(new Set(ids).size).toBe(725)
})

it('prepares independent exact and symmetric-prefix eligibility across engines and repeated requests', async () => {
  harness = await openSessionSearchHarness('ss-eligible-preparation')
  const secondEngine = new SessionSearchEngine(harness.db)
  const title = 'A particularly long conversation title'
  for (let id = 1; id <= 4; id++) {
    addSyntheticSession(harness.db, { id, text: 'a needle here' })
  }
  const titles = [title, title.slice(0, 24), `${title} with more detail`, 'short']
  titles.forEach((value, index) =>
    harness!.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(value, index + 1)
  )
  const long = {
    providers: [],
    prompts: [{ agent: 'claude' as const, prompts: [title, `${title} with more detail`] }]
  }
  const short = {
    providers: [],
    prompts: [{ agent: 'claude' as const, prompts: ['short', 'sho'] }]
  }
  const search = (engine: SessionSearchEngine, eligibleSessions: AiVaultSearchEligibleSessions) =>
    engine
      .search({ query: 'needle', eligibleSessions })
      .hits.map((hit) => hit.sessionId)
      .sort()
  expect(search(harness.engine, long)).toEqual(['1', '2', '3'])
  expect(search(secondEngine, short)).toEqual(['4'])
  expect(search(harness.engine, long)).toEqual(['1', '2', '3'])
  expect(
    search(secondEngine, {
      providers: [],
      prompts: [...long.prompts, { agent: 'claude', prompts: [title.slice(0, 24)] }]
    })
  ).toEqual([])
  expect(search(harness.engine, short)).toEqual(['4'])
  expect(harness.engine.search({ query: 'needle' }).hits).toHaveLength(4)
})
