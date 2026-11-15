import { afterEach, expect, it } from 'vitest'
import './session-search-engine-types'
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

const TOOL = 'zebrafish appears only in the tool output here'

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
