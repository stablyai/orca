import { afterEach, expect, it } from 'vitest'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

let harness: SessionSearchHarness | null = null
let control: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  await control?.close()
  harness = null
  control = null
})

it('repairs whole identifiers despite visible fragments and tool spellings', async () => {
  harness = await openSessionSearchHarness('ss-typo-scope-suppress')
  addSyntheticSession(harness.db, { id: 1, text: 'we changed resolveTerminalPath today', rows: 2 })
  addSyntheticSession(harness.db, {
    id: 2,
    text: 'terminal',
    toolText: 'warning: unknown symbol resolveterminalpth in build log',
    rows: 2,
    role: 'assistant'
  })

  control = await openSessionSearchHarness('ss-typo-scope-control')
  addSyntheticSession(control.db, { id: 1, text: 'we changed resolveTerminalPath today', rows: 2 })
  addSyntheticSession(control.db, { id: 2, text: 'terminal' })

  for (const query of ['resolveterminalpth', 'resolveTerminalPth']) {
    const withTool = harness.engine.search({ query, scope: 'conversation' })
    const clean = control.engine.search({ query, scope: 'all' })
    for (const result of [withTool, clean]) {
      expect(result.planner.repairedTerms).toEqual(['resolveterminalpath'])
      expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
    }
  }
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
  const wide = harness.engine.search({ query: 'quicksilverfx', scope: 'all' })
  expect(wide.planner.repairedTerms).toEqual(['quicksilverfox'])
  expect(wide.hits.map((hit) => hit.sessionId)).toEqual(['1'])
})

it('excludes tool-only spellings before typo visibility and candidate selection in all scope', async () => {
  harness = await openSessionSearchHarness('ss-typo-tool-exclusion')
  addSyntheticSession(harness.db, { id: 1, text: 'quicksilverfox', rows: 2 })
  addSyntheticSession(harness.db, { id: 2, role: 'tool', text: 'quicksilverfx', rows: 10 })
  const page = harness.engine.search({ query: 'quicksilverfx', scope: 'all' })
  expect(page.planner.repairedTerms).toEqual(['quicksilverfox'])
  expect(page.hits.map((hit) => hit.sessionId)).toEqual(['1'])
})

it('keeps an exact spelling in a tool-heavy vocabulary', async () => {
  harness = await openSessionSearchHarness('ss-typo-exhausted-exact')
  addSyntheticSession(harness.db, { id: 1, role: 'tool', text: 'coalesces', rows: 1023 })
  addSyntheticSession(harness.db, { id: 2, text: 'coalesces', rows: 2 })
  addSyntheticSession(harness.db, { id: 3, text: 'coalesce', rows: 2 })
  for (const scope of ['all', 'conversation'] as const) {
    const page = harness.engine.search({ query: 'coalesces', scope })
    expect(page.planner.repairedTerms).toBeUndefined()
    expect(page.hits.map((hit) => hit.sessionId)).toEqual(['2'])
  }
})
