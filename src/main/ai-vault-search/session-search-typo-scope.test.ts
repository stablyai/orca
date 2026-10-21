import { afterEach, expect, it } from 'vitest'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

// Typo repair used to read `messages_vocab` and probe `messages_fts` with no
// column filter, so tool output decided whether a conversation-scoped query was
// repaired — in both directions. A tool row carrying the misspelling made the
// query look correctly spelled and suppressed the repair; a tool row carrying a
// rare word offered it as the suggestion, naming in `repairedTerms` a string
// from a column the scope will never show.

let harness: SessionSearchHarness | null = null
let control: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  await control?.close()
  harness = null
  control = null
})

it('repairs a conversation query the same way with or without a tool row', async () => {
  harness = await openSessionSearchHarness('ss-typo-scope-suppress')
  addSyntheticSession(harness.db, { id: 1, text: 'we changed resolveTerminalPath today', rows: 2 })
  // A second session whose tool output happens to contain the misspelling.
  addSyntheticSession(harness.db, {
    id: 2,
    text: 'ran the linter',
    toolText: 'warning: unknown symbol resolveterminalpth in build log',
    rows: 2,
    role: 'assistant'
  })

  // The same index without that one tool row.
  control = await openSessionSearchHarness('ss-typo-scope-control')
  addSyntheticSession(control.db, { id: 1, text: 'we changed resolveTerminalPath today', rows: 2 })
  addSyntheticSession(control.db, { id: 2, text: 'ran the linter' })

  const request = { query: 'resolveterminalpth', scope: 'conversation' } as const
  const withTool = harness.engine.search(request)
  const clean = control.engine.search(request)

  expect(clean.planner.repairedTerms).toEqual(['resolveterminalpath'])
  expect(clean.hits.map((hit) => hit.sessionId)).toEqual(['1'])
  expect(withTool.planner.repairedTerms).toEqual(clean.planner.repairedTerms)
  expect(withTool.hits.map((hit) => hit.sessionId)).toEqual(clean.hits.map((hit) => hit.sessionId))
})

it('never repairs a conversation query onto a word only tool output holds', async () => {
  harness = await openSessionSearchHarness('ss-typo-scope-leak')
  addSyntheticSession(harness.db, {
    id: 1,
    text: 'ran the deploy',
    toolText: 'AWS_SESSION_TOKEN=quicksilverfox expired',
    rows: 2,
    role: 'assistant'
  })
  addSyntheticSession(harness.db, { id: 2, text: 'ordinary prose about nothing' })

  const narrowed = harness.engine.search({ query: 'quicksilverfx', scope: 'conversation' })
  expect(narrowed.planner.repairedTerms).toBeUndefined()
  expect(narrowed.hits).toEqual([])
  // The same query over the whole corpus still finds it, which is the scope
  // doing its job rather than the repair being broken.
  const wide = harness.engine.search({ query: 'quicksilverfx', scope: 'all' })
  expect(wide.planner.repairedTerms).toEqual(['quicksilverfox'])
  expect(wide.hits.map((hit) => hit.sessionId)).toEqual(['1'])
})
