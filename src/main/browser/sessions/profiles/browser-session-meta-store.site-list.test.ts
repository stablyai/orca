import { describe, expect, it } from 'vitest'

import { forgetBrowserSessionProfileMeta, parseAllowedHosts } from './browser-session-meta-store'

describe('parseAllowedHosts', () => {
  it('keeps valid hosts and drops malformed entries, lists and containers', () => {
    expect(
      parseAllowedHosts({
        p1: ['A.com', 'a.com', 'bad host', 'com', 42, null, '*.b.com'],
        p2: ['1.2.3.4', 'http://x.com'],
        p3: 'not-a-list',
        p4: []
      })
    ).toEqual({ p1: ['a.com', '*.b.com'] })
    expect(parseAllowedHosts(null)).toEqual({})
    expect(parseAllowedHosts(['a.com'])).toEqual({})
    expect(parseAllowedHosts('a.com')).toEqual({})
  })
})

describe('forgetBrowserSessionProfileMeta', () => {
  it("drops a deleted profile's site list and keeps the others", () => {
    const updates = forgetBrowserSessionProfileMeta(
      {
        defaultSource: null,
        pendingCookieDbPath: null,
        pendingCookieImports: {},
        profiles: [],
        enabledExtensionIdsByProfileId: {},
        pinnedExtensionIdsByProfileId: {},
        allowedHostsByProfileId: { p1: ['a.com'], p2: ['b.com'] }
      },
      { id: 'p1', partition: 'persist:p1' },
      'persist:default'
    )
    expect(updates.allowedHostsByProfileId).toEqual({ p2: ['b.com'] })
  })
})
