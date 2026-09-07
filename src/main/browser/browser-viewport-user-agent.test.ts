import { describe, expect, it } from 'vitest'

import { googleAuthUserAgent } from './browser-google-auth-ua'
import { buildViewportUserAgentOverride } from './browser-viewport-user-agent'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

describe('buildViewportUserAgentOverride', () => {
  it('presents the Firefox UA on Google auth hosts regardless of the preset', () => {
    for (const mobile of [false, true]) {
      const override = buildViewportUserAgentOverride({
        url: 'https://accounts.google.com/v3/signin/identifier',
        mobile,
        baseUserAgent: CHROME_UA
      })
      expect(override.userAgent).toBe(googleAuthUserAgent())
      // Real Firefox emits no client hints, so Chrome brands would contradict the stripped headers.
      expect(override.userAgentMetadata).toBeUndefined()
    }
  })

  it('keeps the clean desktop UA off the auth hosts', () => {
    const override = buildViewportUserAgentOverride({
      url: 'https://myaccount.google.com/',
      mobile: false,
      baseUserAgent: CHROME_UA
    })
    expect(override.userAgent).toBe(CHROME_UA)
    expect(override.userAgentMetadata).toBeUndefined()
  })

  it('splices the real Chrome major into the mobile UA and its client hints', () => {
    const override = buildViewportUserAgentOverride({
      url: 'https://example.com/',
      mobile: true,
      baseUserAgent: CHROME_UA
    })
    expect(override.userAgent).toContain('iPhone')
    expect(override.userAgent).toContain('CriOS/134.0.0.0')
    expect(override.userAgentMetadata?.mobile).toBe(true)
    expect(override.userAgentMetadata?.platform).toBe('iOS')
    expect(override.userAgentMetadata?.brands).toContainEqual({
      brand: 'Google Chrome',
      version: '134'
    })
  })

  it('falls back to a known Chrome major when the base UA carries none', () => {
    const override = buildViewportUserAgentOverride({
      url: 'https://example.com/',
      mobile: true,
      baseUserAgent: googleAuthUserAgent()
    })
    expect(override.userAgent).toContain('CriOS/134.0.0.0')
  })

  it('treats an unparseable URL as a non-auth host', () => {
    const override = buildViewportUserAgentOverride({
      url: 'not a url',
      mobile: false,
      baseUserAgent: CHROME_UA
    })
    expect(override.userAgent).toBe(CHROME_UA)
  })
})
