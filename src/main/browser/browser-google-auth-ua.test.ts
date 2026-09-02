import { describe, expect, it } from 'vitest'

import {
  googleAuthUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  stripClientHints
} from './browser-google-auth-ua'

describe('isGoogleAuthUrl', () => {
  it('matches the Google/YouTube sign-in hosts exactly', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/')).toBe(true)
    expect(isGoogleAuthUrl('https://accounts.google.com/v3/signin/identifier')).toBe(true)
    expect(isGoogleAuthUrl('https://accounts.youtube.com/signin')).toBe(true)
    expect(isGoogleAuthUrl('https://ACCOUNTS.GOOGLE.COM/')).toBe(true)
  })

  it('does not match post-auth app subdomains or lookalikes', () => {
    expect(isGoogleAuthUrl('https://myaccount.google.com/')).toBe(false)
    expect(isGoogleAuthUrl('https://mail.google.com/')).toBe(false)
    expect(isGoogleAuthUrl('https://accounts.google.com.evil.test/')).toBe(false)
    expect(isGoogleAuthUrl('https://google.com/')).toBe(false)
    expect(isGoogleAuthUrl('not a url')).toBe(false)
  })
})

describe('googleAuthUserAgent', () => {
  it('produces an internally consistent Firefox UA for the host platform', () => {
    const ua = googleAuthUserAgent()
    expect(ua).toMatch(/^Mozilla\/5\.0 \(.+; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/)
    expect(ua).not.toContain('Chrome')
    expect(ua).not.toContain('Electron')
  })
})

describe('stripClientHints', () => {
  it('removes every sec-ch-ua* header regardless of case, keeps others', () => {
    const headers: Record<string, string> = {
      'sec-ch-ua': 'a',
      'Sec-CH-UA-Platform': 'b',
      'sec-ch-ua-full-version-list': 'c',
      'User-Agent': 'ua',
      Accept: 'text/html'
    }
    stripClientHints(headers)
    expect(Object.keys(headers).some((k) => k.toLowerCase().startsWith('sec-ch-ua'))).toBe(false)
    expect(headers['User-Agent']).toBe('ua')
    expect(headers.Accept).toBe('text/html')
  })
})

describe('setUserAgentHeader', () => {
  it('overwrites an existing user-agent header in place, preserving its casing', () => {
    const headers: Record<string, string> = { 'user-agent': 'old' }
    setUserAgentHeader(headers, 'new')
    expect(headers['user-agent']).toBe('new')
    expect(Object.keys(headers)).toEqual(['user-agent'])
  })

  it('adds a canonical header when none exists', () => {
    const headers: Record<string, string> = {}
    setUserAgentHeader(headers, 'new')
    expect(headers['User-Agent']).toBe('new')
  })
})
