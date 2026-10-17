import { describe, expect, it } from 'vitest'
import { macOSMajorFromDarwinRelease } from './macos-version'

describe('macOSMajorFromDarwinRelease', () => {
  it.each([
    ['20.6.0', 11],
    ['21.6.0', 12],
    ['23.0.0', 14],
    ['24.1.0', 15],
    ['25.0.0', 26]
  ])('maps Darwin %s to macOS %i', (release, major) => {
    expect(macOSMajorFromDarwinRelease(release)).toBe(major)
  })

  it('returns null for non-Darwin or garbage releases', () => {
    expect(macOSMajorFromDarwinRelease('6.8.0-generic')).toBeNull()
    expect(macOSMajorFromDarwinRelease('')).toBeNull()
  })
})
