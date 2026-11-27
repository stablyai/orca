import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER,
  appendWithinUtf8ByteLimit
} from './agent-session-delta-prefix'

describe('appendWithinUtf8ByteLimit', () => {
  it('keeps a surrogate pair split across chunks whole when it truncates', () => {
    const next = appendWithinUtf8ByteLimit(['ab\uD83D'], 5, `\uDE00${'x'.repeat(40)}`, 43, 44)
    expect(next.chunks).toEqual([`ab😀xxxx${AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER}`])
    expect(next.retainedBytes).toBeLessThanOrEqual(44)
    const lone = appendWithinUtf8ByteLimit(['\uD83D'], 3, `😀${'x'.repeat(40)}`, 44, 41)
    expect(lone.chunks).toEqual([`\uFFFD😀${AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER}`])
  })
})
