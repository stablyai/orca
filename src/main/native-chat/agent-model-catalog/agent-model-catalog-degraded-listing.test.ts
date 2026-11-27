import { expect, it } from 'vitest'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import { parseAgyModelListing } from '../../antigravity/antigravity-model-listing'

const listing = (rows: string[]) => parseAgyModelListing(rows.join('\n'))
const levels = (family: string, name: string) =>
  ['high', 'medium', 'low'].map((level) => `${family}-${level}\t${name} (${level})`)
// What a live `agy acp` session, or a good `agy models` run, lists.
const FULL = listing([
  ...levels('gemini-4-neon', 'Gemini 4 Neon'),
  ...levels('gemini-4-argon', 'Gemini 4 Argon'),
  ...levels('gemini-3.8-flash', 'Gemini 3.8 Flash'),
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
])
// A degraded `agy models` run: fewer rows, one renamed, one the full list lacks.
const DEGRADED = listing([
  ...levels('gemini-3.8-flash', 'Gemini 3.8 Flash Lite'),
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)'
])
const ONLY_FULL = ['gemini-4-neon', 'gemini-4-argon', 'gpt-oss-120b-medium']
const MINUTE = 60_000

function catalog() {
  const clock = { now: 1_000_000 }
  const store = new AgentModelCatalogStore({ now: () => clock.now })
  const write = (models: typeof FULL, source: 'discovery' | 'live', fp = 'fp') => {
    clock.now += 1
    return store.recordSuccess(
      fp,
      'antigravity',
      { models, origin: source === 'live' ? 'live-session' : 'probe' },
      source
    )
  }
  const ids = (fp = 'fp') => store.get(fp)?.models.map((model) => model.id) ?? []
  return { clock, store, write, ids }
}

it("a short probe adds to what this process's chats listed, and a probe as long replaces it", () => {
  const { write, ids } = catalog()
  write(FULL, 'live')
  write(DEGRADED, 'discovery')
  expect(ids()).toEqual(expect.arrayContaining([...ONLY_FULL, 'claude-sonnet-4-6']))
  // As long as the 5 rows seen: it replaces them, also in front of the older chat listing.
  const next = listing(['n', 'o', 'p', 'q', 'r'].flatMap((id) => levels(id, id.toUpperCase())))
  write(next, 'discovery')
  expect(ids()).toEqual(next.map((model) => model.id))
})

it('a short probe never replaces a longer one from this process, and lists again 5 minutes later', () => {
  const { clock, write, ids, store } = catalog()
  write(FULL, 'discovery')
  clock.now += MINUTE
  write(DEGRADED, 'discovery')
  const probed = clock.now
  expect(ids()).toEqual(expect.arrayContaining([...ONLY_FULL, 'claude-sonnet-4-6']))
  expect(store.get('fp')?.models.find((model) => model.id === 'gemini-3.8-flash')?.label).toBe(
    'Gemini 3.8 Flash Lite'
  )
  clock.now = probed + 5 * MINUTE - 1
  expect(store.shouldRefresh('fp')).toBe(false)
  clock.now = probed + 5 * MINUTE
  expect(store.shouldRefresh('fp')).toBe(true)
})

it('a short probe lists again 5 minutes later by the clock, also after the clock stepped back', () => {
  const { clock, write, store } = catalog()
  write(FULL, 'discovery')
  clock.now -= 60 * MINUTE
  write(DEGRADED, 'discovery')
  const probed = clock.now
  clock.now = probed + 5 * MINUTE - 1
  expect(store.shouldRefresh('fp')).toBe(false)
  clock.now = probed + 5 * MINUTE
  expect(store.shouldRefresh('fp')).toBe(true)
})

it("selecting another account drops only the rows seen under that login; other homes' catalogs stay fresh", () => {
  const { write, ids, store } = catalog()
  for (const fp of ['host-fp', 'orca-fp']) {
    write(FULL, 'discovery', fp)
    write(FULL, 'live', fp)
  }
  store.forgetSeenRows(['host-fp'])
  expect([store.shouldRefresh('host-fp'), store.shouldRefresh('orca-fp')]).toEqual([true, false])
  write(DEGRADED, 'discovery', 'host-fp')
  write(DEGRADED, 'discovery', 'orca-fp')
  expect(ids('host-fp')).toEqual(DEGRADED.map((model) => model.id))
  expect(ids('orca-fp')).toEqual(expect.arrayContaining(ONLY_FULL))
})

it("a first probe still running when the account changes saves nothing of the previous account's", async () => {
  const { write, ids, store } = catalog()
  const previous = Promise.withResolvers<{ models: typeof FULL; origin: 'probe' }>()
  const probing = store.refresh('fp', 'antigravity', () => previous.promise)
  store.forgetSeenRows(['fp'])
  previous.resolve({ models: FULL, origin: 'probe' })
  await probing
  write(DEGRADED, 'discovery')
  expect(ids()).toEqual(DEGRADED.map((model) => model.id))
})

it('an equally long probe in the same millisecond as a chat listing replaces what it showed', () => {
  const store = new AgentModelCatalogStore({ now: () => 1_000_000 })
  const next = listing([
    ...levels('gemini-3.8-flash', 'Gemini 3.8 Flash Next'),
    ...['x', 'y', 'z'].flatMap((id) => levels(id, id.toUpperCase()))
  ])
  store.recordSuccess('fp', 'antigravity', { models: FULL, origin: 'live-session' }, 'live')
  store.recordSuccess('fp', 'antigravity', { models: next, origin: 'probe' }, 'discovery')
  expect(store.get('fp')?.models.map(({ id, label }) => [id, label])).toEqual([
    ['gemini-3.8-flash', 'Gemini 3.8 Flash Next'],
    ['x', 'X'],
    ['y', 'Y'],
    ['z', 'Z']
  ])
})

it('a Refresh lists its own catalog again past a failure hold and leaves sibling listings running', async () => {
  const { write, store } = catalog()
  write(FULL, 'discovery')
  write(FULL, 'discovery', 'other-fp')
  void store.refresh('other-fp', 'antigravity', () => new Promise(() => {}))
  await store.refresh('cold-fp', 'antigravity', () =>
    Promise.reject(new Error('agy models failed'))
  )
  expect(store.shouldRefresh('cold-fp')).toBe(false)
  const revision = store.retirementRevision('antigravity')
  store.relistScope('cold-fp')
  store.relistScope('fp')
  expect(store.shouldRefresh('cold-fp')).toBe(true)
  expect(store.shouldRefresh('fp')).toBe(true)
  expect(store.isListing('other-fp')).toBe(true)
  expect(store.retirementRevision('antigravity')).toBe(revision)
})
