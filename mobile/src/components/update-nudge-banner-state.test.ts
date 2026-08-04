import { describe, expect, it } from 'vitest'
import {
  getRecommendedVersionForPlatform,
  isAppVersionOlder,
  shouldShowUpdateNudge
} from './update-nudge-banner-state'

describe('getRecommendedVersionForPlatform', () => {
  const versions = { ios: '0.0.33', android: '0.0.32' }

  it('selects the independently shipped version for the running platform', () => {
    expect(getRecommendedVersionForPlatform('ios', versions)).toBe('0.0.33')
    expect(getRecommendedVersionForPlatform('android', versions)).toBe('0.0.32')
  })

  it('fails open for an unsupported platform or absent recommendation', () => {
    expect(getRecommendedVersionForPlatform('web', versions)).toBeNull()
    expect(getRecommendedVersionForPlatform('ios', null)).toBeNull()
  })
})

describe('isAppVersionOlder', () => {
  it('compares segments numerically, not lexically', () => {
    expect(isAppVersionOlder('0.0.9', '0.0.32')).toBe(true)
    expect(isAppVersionOlder('0.0.32', '0.0.9')).toBe(false)
    expect(isAppVersionOlder('0.9.0', '0.32.0')).toBe(true)
    expect(isAppVersionOlder('1.0.0', '2.0.0')).toBe(true)
  })

  it('treats equal versions and missing segments as not older', () => {
    expect(isAppVersionOlder('0.0.32', '0.0.32')).toBe(false)
    expect(isAppVersionOlder('1.4', '1.4.0')).toBe(false)
    expect(isAppVersionOlder('1.4.0', '1.4')).toBe(false)
    expect(isAppVersionOlder('1.4', '1.4.1')).toBe(true)
  })

  it('fails open on unparsable versions', () => {
    expect(isAppVersionOlder('0.0.1-dev', '0.0.32')).toBe(false)
    expect(isAppVersionOlder('0.0.1', 'latest')).toBe(false)
    expect(isAppVersionOlder('', '0.0.32')).toBe(false)
    expect(isAppVersionOlder('0.0.1', '')).toBe(false)
  })
})

describe('shouldShowUpdateNudge', () => {
  const base = {
    recommendedVersion: '0.0.33',
    installedVersion: '0.0.32',
    dismissedVersion: null,
    dismissedLoaded: true
  }

  it('shows the nudge when installed is older than recommended', () => {
    expect(shouldShowUpdateNudge(base)).toBe(true)
  })

  it('shows nothing when up to date or ahead', () => {
    expect(shouldShowUpdateNudge({ ...base, installedVersion: '0.0.33' })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, installedVersion: '0.0.34' })).toBe(false)
  })

  it('fails open when the desktop predates the field or versions are unknown', () => {
    expect(shouldShowUpdateNudge({ ...base, recommendedVersion: undefined })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, recommendedVersion: null })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, installedVersion: undefined })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, installedVersion: null })).toBe(false)
  })

  it('stays hidden until the persisted dismissal has loaded', () => {
    expect(shouldShowUpdateNudge({ ...base, dismissedLoaded: false })).toBe(false)
  })

  it('resurfaces only recommendations newer than the dismissed version', () => {
    expect(shouldShowUpdateNudge({ ...base, dismissedVersion: '0.0.33' })).toBe(false)
    // Why: a newer recommendation must resurface the nudge after an old dismissal.
    expect(shouldShowUpdateNudge({ ...base, dismissedVersion: '0.0.32' })).toBe(true)
    // Why: switching to a stale host must not resurrect a recommendation the user already surpassed.
    expect(
      shouldShowUpdateNudge({
        ...base,
        recommendedVersion: '0.0.32',
        installedVersion: '0.0.31',
        dismissedVersion: '0.0.33'
      })
    ).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, dismissedVersion: 'invalid' })).toBe(true)
  })
})
