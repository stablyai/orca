import { describe, expect, it } from 'vitest'
import { shouldCopySyntheticTitleFrameToPtyData } from './synthetic-title-frame-routing'

describe('shouldCopySyntheticTitleFrameToPtyData', () => {
  it('keeps the legacy pty:data copy only while the kill switch is off', () => {
    expect(shouldCopySyntheticTitleFrameToPtyData({ terminalMainSideEffectAuthority: false })).toBe(
      true
    )
  })

  it('skips the copy under main authority — tracker ingest is the only consumer', () => {
    expect(shouldCopySyntheticTitleFrameToPtyData({ terminalMainSideEffectAuthority: true })).toBe(
      false
    )
    expect(shouldCopySyntheticTitleFrameToPtyData({})).toBe(false)
    expect(shouldCopySyntheticTitleFrameToPtyData(null)).toBe(false)
    expect(shouldCopySyntheticTitleFrameToPtyData(undefined)).toBe(false)
  })
})
