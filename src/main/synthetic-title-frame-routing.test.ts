import { describe, expect, it } from 'vitest'
import { shouldCopySyntheticTitleFrameToPtyData } from './synthetic-title-frame-routing'

describe('shouldCopySyntheticTitleFrameToPtyData', () => {
  it('keeps the legacy pty:data copy only while the kill switch is off', () => {
    // Authority off: renderer byte parsers are the sole synthetic-frame
    // consumer, so the legacy copy must keep flowing.
    expect(shouldCopySyntheticTitleFrameToPtyData({ terminalMainSideEffectAuthority: false })).toBe(
      true
    )
  })

  it('skips the copy under main authority — tracker ingest is the only consumer', () => {
    // Why: under authority the copy would only mint phantom renderer ACKs
    // for fabricated bytes main never metered.
    expect(shouldCopySyntheticTitleFrameToPtyData({ terminalMainSideEffectAuthority: true })).toBe(
      false
    )
    // Default-on: an unset switch means main authority.
    expect(shouldCopySyntheticTitleFrameToPtyData({})).toBe(false)
    expect(shouldCopySyntheticTitleFrameToPtyData(null)).toBe(false)
    expect(shouldCopySyntheticTitleFrameToPtyData(undefined)).toBe(false)
  })
})
