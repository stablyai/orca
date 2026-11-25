import { describe, expect, it } from 'vitest'
import { matchBrowserPasswordEntries } from './browser-password-origin'

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
})
