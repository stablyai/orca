import { describe, expect, it } from 'vitest'

import { googleAuthUserAgent } from './browser-google-auth-ua'
import { resolveBrowserTabIdentity } from './browser-tab-identity'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const NATIVE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orca/1.0.0 Chrome/134.0.0.0 Electron/43.0.0 Safari/537.36'
const clean = { mode: 'clean', userAgent: CHROME_UA } as const
const native = { mode: 'native', userAgent: NATIVE_UA } as const
const AUTH_URL = 'https://accounts.google.com/v3/signin/identifier'

describe('resolveBrowserTabIdentity', () => {
  it('presents Firefox on Google auth hosts in clean mode regardless of the preset', () => {
    for (const mobile of [false, true]) {
      expect(resolveBrowserTabIdentity({ url: AUTH_URL, mobile, processIdentity: clean })).toEqual({
        kind: 'google-auth',
        userAgent: googleAuthUserAgent()
      })
    }
  })

  it('leaves Google auth hosts on the native identity in native mode', () => {
    expect(
      resolveBrowserTabIdentity({ url: AUTH_URL, mobile: false, processIdentity: native })
    ).toEqual({ kind: 'process', userAgent: NATIVE_UA })
    expect(
      resolveBrowserTabIdentity({ url: AUTH_URL, mobile: true, processIdentity: native }).kind
    ).toBe('mobile')
  })

  it('presents the process identity itself off the auth hosts without a mobile preset', () => {
    for (const processIdentity of [clean, native]) {
      expect(
        resolveBrowserTabIdentity({
          url: 'https://myaccount.google.com/',
          mobile: false,
          processIdentity
        })
      ).toEqual({ kind: 'process', userAgent: processIdentity.userAgent })
    }
  })

  it('splices the real Chrome major into the mobile UA and its client hints', () => {
    const identity = resolveBrowserTabIdentity({
      url: 'https://example.com/',
      mobile: true,
      processIdentity: clean
    })
    expect(identity.kind).toBe('mobile')
    expect(identity.userAgent).toContain('iPhone')
    expect(identity.userAgent).toContain('CriOS/134.0.0.0')
    if (identity.kind === 'mobile') {
      expect(identity.userAgentMetadata.mobile).toBe(true)
      expect(identity.userAgentMetadata.platform).toBe('iOS')
      expect(identity.userAgentMetadata.brands).toContainEqual({
        brand: 'Google Chrome',
        version: '134'
      })
    }
  })

  it('falls back to a known Chrome major when the process UA carries none', () => {
    const identity = resolveBrowserTabIdentity({
      url: 'https://example.com/',
      mobile: true,
      processIdentity: { mode: 'clean', userAgent: googleAuthUserAgent() }
    })
    expect(identity.userAgent).toContain('CriOS/134.0.0.0')
  })

  it('treats an unparseable URL as a non-auth host', () => {
    expect(
      resolveBrowserTabIdentity({ url: 'not a url', mobile: false, processIdentity: clean })
    ).toEqual({ kind: 'process', userAgent: CHROME_UA })
  })
})
