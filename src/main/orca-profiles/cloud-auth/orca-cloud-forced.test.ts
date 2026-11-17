import { describe, expect, it } from 'vitest'
import { forcedOrcaCloudAvailability } from './orca-cloud-forced'

describe('forcedOrcaCloudAvailability', () => {
  it('follows the account capability only in packaged public builds', () => {
    expect(forcedOrcaCloudAvailability({}, true, false)).toBeNull()
    expect(forcedOrcaCloudAvailability({}, false, false)).toBe(true)
    expect(forcedOrcaCloudAvailability({}, true, true)).toBe(true)
    expect(
      forcedOrcaCloudAvailability({ ORCA_CLOUD_API_URL: 'https://staging.example' }, true, false)
    ).toBe(true)
  })

  it('lets ORCA_CLOUD_AVAILABLE override every build', () => {
    expect(forcedOrcaCloudAvailability({ ORCA_CLOUD_AVAILABLE: '0' }, false, true)).toBe(false)
    expect(forcedOrcaCloudAvailability({ ORCA_CLOUD_AVAILABLE: '1' }, true, false)).toBe(true)
  })
})
