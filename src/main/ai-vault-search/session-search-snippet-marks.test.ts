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
