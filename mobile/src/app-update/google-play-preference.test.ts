import { describe, expect, it } from 'vitest'
import { isLikelyInMainlandChina, shouldPreferGooglePlay } from './google-play-preference'

describe('isLikelyInMainlandChina', () => {
  it('detects a Chinese region or a mainland time zone, either alone', () => {
    expect(isLikelyInMainlandChina({ regionCodes: ['CN'], timeZone: 'America/New_York' })).toBe(
      true
    )
    expect(isLikelyInMainlandChina({ regionCodes: ['US'], timeZone: 'Asia/Shanghai' })).toBe(true)
    expect(isLikelyInMainlandChina({ regionCodes: [null, 'cn'], timeZone: null })).toBe(true)
  })

  it('does not treat Hong Kong, Taiwan or other regions as mainland China', () => {
    expect(isLikelyInMainlandChina({ regionCodes: ['HK'], timeZone: 'Asia/Hong_Kong' })).toBe(false)
    expect(isLikelyInMainlandChina({ regionCodes: ['TW'], timeZone: 'Asia/Taipei' })).toBe(false)
    expect(isLikelyInMainlandChina({ regionCodes: [], timeZone: undefined })).toBe(false)
  })
})

describe('shouldPreferGooglePlay', () => {
  const base = {
    isAndroid: true,
    isRetiredApp: false,
    isInstalledByPlay: false,
    playStoreUsable: true,
    inMainlandChina: false
  }

  it('steers a GitHub install outside China to Play', () => {
    expect(shouldPreferGooglePlay(base)).toBe(true)
  })

  it.each([
    ['iOS', { isAndroid: false }],
    ['the retired app', { isRetiredApp: true }],
    ['a Play install, which Play already updates', { isInstalledByPlay: true }],
    ['a phone without a working Play Store', { playStoreUsable: false }],
    ['mainland China', { inMainlandChina: true }]
  ])('does not for %s', (_name, override) => {
    expect(shouldPreferGooglePlay({ ...base, ...override })).toBe(false)
  })
})
