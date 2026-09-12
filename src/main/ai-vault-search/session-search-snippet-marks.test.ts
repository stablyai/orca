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

// A snippet has to name which of a row's four columns matched, and the marks
// FTS5 wraps a match in are the only signal. Searching the marked text for the
// public `[[` reads a transcript's own brackets as a highlight — and transcripts
// are full of them, because a bash `[[ -f x ]]` and numpy's `[[1, 2]]` are
// exactly the sort of thing an agent session holds. Whether a column matched is
// the difference between two renderings of the same text instead.

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

const BASH = 'run this: if [[ -f /home/me/.aws/credentials ]]; then cat it; fi'
const TOOL = 'zebrafish appears only in the tool output here'

it('shows the column that matched, not the one that happens to contain brackets', async () => {
  harness = await openSessionSearchHarness('ss-snippet-marks')
  // Session 1's match is in tool output while its user turn holds a bash test
  // expression; session 2 is the same match with no brackets anywhere.
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
  // `zebra` reaches this row only through the identifier shadow column, which is
  // what column -1 exists for. The user turn holds numpy output, so a bracket
  // scan would have stopped at it and shown a column with no match in it.
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
  // The marks are rewritten from private-use code points at the very end, so a
  // row that both matches and contains `[[` keeps its own characters.
  harness = await openSessionSearchHarness('ss-snippet-marks-literal')
  addSyntheticSession(harness.db, { id: 1, text: `zebrafish ${BASH}` })

  const [hit] = harness.engine.search({ query: 'zebrafish' }).hits
  expect(hit?.evidence?.snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebrafish${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
  expect(hit?.evidence?.snippet).toContain('[[ -f')
})

it('picks by comparison, so a private-use code point in content cannot pose as a mark', async () => {
  // The marks are private-use code points, and a transcript may hold one:
  // agent output carries Nerd Font glyphs, which live in the same block. So the
  // column is chosen by comparing a marked rendering against an unmarked one,
  // not by looking for a mark in the text.
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
  // Over the character ceiling the snippet is cut, and it must not cut between
  // an open mark and its close. Finding that open mark by searching for `[[`
  // stops at the transcript's own bracket instead and throws away everything
  // after it.
  harness = await openSessionSearchHarness('ss-snippet-marks-truncation')
  const long = (letter: string): string =>
    Array.from({ length: 5 }, () => `${letter.repeat(55)}/tail`).join(' ')
  addSyntheticSession(harness.db, {
    id: 1,
    text: `zebrafish ${long('p')} [[ ${long('q')}`
  })

  const snippet = harness.engine.search({ query: 'zebrafish' }).hits[0]?.evidence?.snippet ?? ''
  expect(snippet).toContain('[[zebrafish]]')
  // The cut is the character ceiling, so the text after the transcript's own
  // bracket survives up to it.
  expect(snippet).toContain('qqqqq')
})

it('marks only what FTS5 marked, so a glyph in the text stays a glyph', async () => {
  // The marked and plain renderings are compared character by character, so a
  // private-use code point the transcript wrote has a counterpart in both and
  // is text; replacing every one of them would show it as a highlight.
  harness = await openSessionSearchHarness('ss-snippet-marks-literal-private-use')
  addSyntheticSession(harness.db, { id: 1, text: 'a \uE000 glyph then zebrafish and \uE001 after' })

  const snippet = harness.engine.search({ query: 'zebrafish' }).hits[0]?.evidence?.snippet ?? ''
  expect(snippet).toContain(
    `${SESSION_SEARCH_SNIPPET_MARK_OPEN}zebrafish${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
  )
  expect(snippet).toContain('a \uE000 glyph')
  expect(snippet).toContain('\uE001 after')
  // One highlight, and only one: the literals are not a second pair.
  expect(snippet.split(SESSION_SEARCH_SNIPPET_MARK_OPEN)).toHaveLength(2)
})

it('does not cut a snippet at a private-use code point the transcript wrote', async () => {
  // The balance check looks for the last open mark, and a content glyph is not
  // one; treating it as one throws away every character after it.
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
