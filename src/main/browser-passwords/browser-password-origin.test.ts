import { describe, expect, it } from 'vitest'
import {
  matchBrowserPasswordEntries,
  registrableDomainOf,
  toBrowserPasswordOrigin
} from './browser-password-origin'

describe('toBrowserPasswordOrigin', () => {
  it('keeps scheme, host and non-default port only', () => {
    expect(toBrowserPasswordOrigin('https://user:pw@Example.COM/login?x=1#frag')).toBe(
      'https://example.com'
    )
    expect(toBrowserPasswordOrigin('http://example.com:80/a')).toBe('http://example.com')
    expect(toBrowserPasswordOrigin('https://example.com:443')).toBe('https://example.com')
    expect(toBrowserPasswordOrigin('https://example.com:8443/')).toBe('https://example.com:8443')
    expect(toBrowserPasswordOrigin('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('serialises IDN hosts as punycode', () => {
    expect(toBrowserPasswordOrigin('https://bücher.de/')).toBe('https://xn--bcher-kva.de')
  })

  it('rejects non-web schemes and garbage', () => {
    expect(toBrowserPasswordOrigin('ftp://example.com')).toBeNull()
    expect(toBrowserPasswordOrigin('android://hash@com.example/')).toBeNull()
    expect(toBrowserPasswordOrigin('file:///etc/passwd')).toBeNull()
    expect(toBrowserPasswordOrigin('example.com')).toBeNull()
    expect(toBrowserPasswordOrigin('')).toBeNull()
  })
})

describe('registrableDomainOf', () => {
  it('returns eTLD+1 including private suffixes', () => {
    expect(registrableDomainOf('https://accounts.google.com')).toBe('google.com')
    expect(registrableDomainOf('https://a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomainOf('https://alice.github.io')).toBe('alice.github.io')
  })

  it('returns the bare host for IPs and localhost', () => {
    expect(registrableDomainOf('http://127.0.0.1:8080')).toBe('127.0.0.1')
    expect(registrableDomainOf('http://localhost:3000')).toBe('localhost')
  })
})

describe('matchBrowserPasswordEntries', () => {
  const entry = (id: string, origin: string, updatedAt = 0, lastUsedAt: number | null = null) => ({
    id,
    origin,
    updatedAt,
    lastUsedAt
  })

  it('splits exact and same-site matches and never crosses scheme or port', () => {
    const entries = [
      entry('exact', 'https://login.example.com'),
      entry('sibling', 'https://www.example.com'),
      entry('http', 'http://login.example.com'),
      entry('port', 'https://www.example.com:8443'),
      entry('other', 'https://example.org'),
      entry('pages-sibling', 'https://bob.github.io')
    ]
    const result = matchBrowserPasswordEntries(entries, 'https://login.example.com')
    expect(result.exact.map((e) => e.id)).toEqual(['exact'])
    expect(result.sameSite.map((e) => e.id)).toEqual(['sibling'])

    const pages = matchBrowserPasswordEntries(entries, 'https://alice.github.io')
    expect(pages.exact).toEqual([])
    expect(pages.sameSite).toEqual([])
  })

  it('sorts by last used, then updated, newest first', () => {
    const entries = [
      entry('old', 'https://example.com', 1, null),
      entry('newer-update', 'https://example.com', 5, null),
      entry('used', 'https://example.com', 0, 10)
    ]
    expect(
      matchBrowserPasswordEntries(entries, 'https://example.com').exact.map((e) => e.id)
    ).toEqual(['used', 'newer-update', 'old'])
  })

  it('matches nothing for a non-web page', () => {
    expect(matchBrowserPasswordEntries([entry('a', 'https://example.com')], 'about:blank')).toEqual(
      { exact: [], sameSite: [] }
    )
  })
})
