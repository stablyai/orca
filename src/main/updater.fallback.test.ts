import { describe, expect, it } from 'vitest'
import { compareVersions, isPrereleaseVersion } from './updater-fallback'

describe('compareVersions', () => {
  it('compares prerelease and build semver strings correctly', () => {
    expect(compareVersions('1.0.70-rc.1', '1.0.69')).toBeGreaterThan(0)
    expect(compareVersions('1.0.70', '1.0.70-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.70+build.5', '1.0.70')).toBe(0)
    expect(compareVersions('v1.0.70-beta.2', '1.0.70-beta.1')).toBeGreaterThan(0)
  })
})

describe('isPrereleaseVersion', () => {
  it('recognises RC, beta, and alpha variants', () => {
    expect(isPrereleaseVersion('1.3.17-rc.1')).toBe(true)
    expect(isPrereleaseVersion('v1.3.17-rc.2')).toBe(true)
    expect(isPrereleaseVersion('1.0.0-beta.5')).toBe(true)
    expect(isPrereleaseVersion('2.1.0-alpha')).toBe(true)
  })

  it('returns false for stable releases and unparseable values', () => {
    expect(isPrereleaseVersion('1.3.17')).toBe(false)
    expect(isPrereleaseVersion('v1.3.17')).toBe(false)
    expect(isPrereleaseVersion('1.3.17+build.5')).toBe(false)
    expect(isPrereleaseVersion('not-a-version')).toBe(false)
  })
})
