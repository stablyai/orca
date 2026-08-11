import { describe, expect, it } from 'vitest'
import { isMultiProfileUiEnabled } from './profile-ui-scope'

describe('isMultiProfileUiEnabled', () => {
  it('enables multi-profile UI only when the flag is exactly "1"', () => {
    expect(isMultiProfileUiEnabled({ ORCA_MULTI_PROFILE_UI: '1' })).toBe(true)
  })

  it('defaults to the single-profile account menu', () => {
    expect(isMultiProfileUiEnabled({})).toBe(false)
    expect(isMultiProfileUiEnabled({ ORCA_MULTI_PROFILE_UI: '0' })).toBe(false)
    expect(isMultiProfileUiEnabled({ ORCA_MULTI_PROFILE_UI: 'true' })).toBe(false)
  })
})
