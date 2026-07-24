import { describe, expect, it } from 'vitest'
import {
  appendScrcpyServerLogPreview,
  SCRCPY_SERVER_LOG_PREVIEW_CHARS
} from './scrcpy-stream-session'

describe('appendScrcpyServerLogPreview', () => {
  it('preserves the diagnostic prefix while bounding a chatty long-lived server', () => {
    const prefix = 'startup\n'
    const first = appendScrcpyServerLogPreview(prefix, Buffer.from('x'.repeat(100_000)))
    const complete = appendScrcpyServerLogPreview(first, Buffer.from('ignored forever'))

    expect(complete).toBe(first)
    expect(complete).toHaveLength(SCRCPY_SERVER_LOG_PREVIEW_CHARS)
    expect(complete.startsWith(prefix)).toBe(true)
  })
})
