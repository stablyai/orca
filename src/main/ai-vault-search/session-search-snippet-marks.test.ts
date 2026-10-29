import { afterEach, expect, it } from 'vitest'
import {
  SESSION_SEARCH_SNIPPET_MARK_CLOSE,
  SESSION_SEARCH_SNIPPET_MARK_OPEN
} from './session-search-engine-types'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

const BASH = 'run this: if [[ -f /home/me/.aws/credentials ]]; then cat it; fi'
const TOOL = 'zebrafish appears only in the tool output here'

it('shows the column that matched, not the one that happens to contain brackets', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks')
  addSyntheticSession(harness.db, { id: 1, text: BASH, toolText: TOOL })
  addSyntheticSession(harness.db, { id: 2, text: 'run this script please', toolText: TOOL })

  const hits = harness.engine.search({ query: 'zebrafish' }).hits
  expect(hits).toHaveLength(2)
  for (const hit of hits) {
    expect(hit.evidence?.snippet).toContain(
      `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebrafish${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
    )
    expect(hit.evidence?.snippet).not.toContain('credentials')
  }
})

it('falls back to any column for an identifier-only match, brackets or not', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks-fallback')
  addSyntheticSession(harness.db, {
    id: 1,
    text: 'numpy printed [[1, 2], [3, 4]] before the call',
    toolText: 'zebra-fish-count = 4'
  })

  const [hit] = harness.engine.search({ query: 'zebra' }).hits
  expect(hit?.evidence?.snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebra${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
  expect(hit?.evidence?.snippet).not.toContain('numpy')
})

it('leaves a transcript’s own brackets in the text it shows', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks-literal')
  addSyntheticSession(harness.db, { id: 1, text: `zebrafish ${BASH}` })

  const [hit] = harness.engine.search({ query: 'zebrafish' }).hits
  expect(hit?.evidence?.snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebrafish${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
  expect(hit?.evidence?.snippet).toContain('[[ -f')
})

it('picks by comparison, so a private-use code point in content cannot pose as a mark', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks-private-use')
  addSyntheticSession(harness.db, {
    id: 1,
    text: 'the \uE000 glyph a font printed here',
    toolText: TOOL
  })

  const [hit] = harness.engine.search({ query: 'zebrafish' }).hits
  expect(hit?.evidence?.snippet).toContain('zebrafish')
  expect(hit?.evidence?.snippet).not.toContain('glyph')
})

it('truncates on the last real mark, not on a bracket the transcript wrote', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks-truncation')
  const long = (letter: string): string =>
    Array.from({ length: 5 }, () => `${letter.repeat(55)}/tail`).join(' ')
  addSyntheticSession(harness.db, {
    id: 1,
    text: `zebrafish ${long('p')} [[ ${long('q')}`
  })

  const snippet = harness.engine.search({ query: 'zebrafish' }).hits[0]?.evidence?.snippet ?? ''
  expect(snippet).toContain('[[zebrafish]]')
  expect(snippet).toContain('qqqqq')
})

it('marks only what FTS5 marked, so a glyph in the text stays a glyph', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks-literal-private-use')
  addSyntheticSession(harness.db, { id: 1, text: 'a \uE000 glyph then zebrafish and \uE001 after' })

  const snippet = harness.engine.search({ query: 'zebrafish' }).hits[0]?.evidence?.snippet ?? ''
  expect(snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebrafish${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
  expect(snippet).toContain('a \uE000 glyph')
  expect(snippet).toContain('\uE001 after')
  expect(snippet.split(SESSION_SEARCH_SNIPPET_MARK_OPEN)).toHaveLength(2)
})

it('does not cut a snippet at a private-use code point the transcript wrote', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks-literal-truncation')
  const long = (letter: string): string =>
    Array.from({ length: 5 }, () => `${letter.repeat(55)}/tail`).join(' ')
  addSyntheticSession(harness.db, { id: 1, text: `zebrafish ${long('p')} \uE000 ${long('q')}` })

  const snippet = harness.engine.search({ query: 'zebrafish' }).hits[0]?.evidence?.snippet ?? ''
  expect(snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebrafish${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
  expect(snippet).toContain('qqqqq')
})

it('marks a phrase hit as one run, stop words included', async () => {
  harness = await openSessionSearchHarness('ss-snippet-phrase-run')
  addSyntheticSession(harness.db, {
    id: 1,
    text: 'Agent: the code already has several fixes for blank restores, including replaying'
  })

  const result = harness.engine.search({ query: 'the code already has several fixes' })
  expect(result.planner.route).toBe('phrase')
  expect(result.hits[0]?.evidence?.snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}the code already has several fixes${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
})

it('marks every typed word of an AND hit, stop words included', async () => {
  harness = await openSessionSearchHarness('ss-snippet-and-words')
  addSyntheticSession(harness.db, { id: 1, text: 'fixes for the restore path, several of them' })

  const result = harness.engine.search({ query: 'several fixes for the restore' })
  expect(result.planner.route).toBe('and')
  const snippet = result.hits[0]?.evidence?.snippet ?? ''
  for (const word of ['several', 'fixes', 'for', 'the', 'restore']) {
    expect(snippet).toContain(
      `${SESSION_SEARCH_SNIPPET_MARK_OPEN}${word}${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
    )
  }
})
