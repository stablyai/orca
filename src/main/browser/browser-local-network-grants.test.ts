import { describe, expect, it } from 'vitest'

import {
  clearLocalNetworkGrants,
  eligibleLocalNetworkOrigin,
  grantLocalNetworkAccess,
  hasLocalNetworkGrant,
  isLocalNetworkPermission,
  localNetworkGrantEpoch
} from './browser-local-network-grants'

describe('local network permission names', () => {
  it('covers the three names Chromium asks with, and nothing else', () => {
    for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
      expect(isLocalNetworkPermission(name)).toBe(true)
    }
    for (const name of ['notifications', 'media', 'geolocation', 'openExternal', 'network']) {
      expect(isLocalNetworkPermission(name)).toBe(false)
    }
  })
})

describe('eligibleLocalNetworkOrigin', () => {
  it('accepts an https page asking for itself', () => {
    expect(
      eligibleLocalNetworkOrigin('https://acme.okta.com/app/x', 'https://acme.okta.com/signin')
    ).toBe('https://acme.okta.com')
    expect(eligibleLocalNetworkOrigin('https://acme.okta.com', 'https://acme.okta.com/')).toBe(
      'https://acme.okta.com'
    )
  })

  it('refuses http, opaque and unparseable origins', () => {
    expect(eligibleLocalNetworkOrigin('http://acme.test/', 'http://acme.test/')).toBeNull()
    expect(eligibleLocalNetworkOrigin('data:text/html,hi', 'data:text/html,hi')).toBeNull()
    expect(eligibleLocalNetworkOrigin('null', 'null')).toBeNull()
    expect(eligibleLocalNetworkOrigin('', '')).toBeNull()
    expect(eligibleLocalNetworkOrigin(undefined, 'https://acme.test/')).toBeNull()
    expect(eligibleLocalNetworkOrigin('https://acme.test/', undefined)).toBeNull()
  })

  it('refuses a frame whose origin differs from the top-level page', () => {
    expect(eligibleLocalNetworkOrigin('https://ads.test/', 'https://acme.test/')).toBeNull()
    expect(eligibleLocalNetworkOrigin('https://sub.acme.test/', 'https://acme.test/')).toBeNull()
    expect(eligibleLocalNetworkOrigin('https://acme.test:8443/', 'https://acme.test/')).toBeNull()
  })

  it('refuses an https frame inside an http page', () => {
    expect(eligibleLocalNetworkOrigin('https://acme.test/', 'http://acme.test/')).toBeNull()
  })
})

describe('local network grants', () => {
  it('scopes a grant to its partition and origin', () => {
    grantLocalNetworkAccess('persist:a', 'https://acme.test', localNetworkGrantEpoch('persist:a'))
    expect(hasLocalNetworkGrant('persist:a', 'https://acme.test')).toBe(true)
    expect(hasLocalNetworkGrant('persist:b', 'https://acme.test')).toBe(false)
    expect(hasLocalNetworkGrant('persist:a', 'https://other.test')).toBe(false)
    clearLocalNetworkGrants('persist:a')
  })

  it('drops every grant of a removed partition only', () => {
    grantLocalNetworkAccess('persist:a', 'https://acme.test', localNetworkGrantEpoch('persist:a'))
    grantLocalNetworkAccess('persist:b', 'https://acme.test', localNetworkGrantEpoch('persist:b'))
    clearLocalNetworkGrants('persist:a')
    expect(hasLocalNetworkGrant('persist:a', 'https://acme.test')).toBe(false)
    expect(hasLocalNetworkGrant('persist:b', 'https://acme.test')).toBe(true)
    clearLocalNetworkGrants('persist:b')
  })

  it('refuses a grant read against an epoch from before the partition was cleared', () => {
    const epoch = localNetworkGrantEpoch('persist:a')
    clearLocalNetworkGrants('persist:a')
    expect(grantLocalNetworkAccess('persist:a', 'https://acme.test', epoch)).toBe(false)
    expect(hasLocalNetworkGrant('persist:a', 'https://acme.test')).toBe(false)
  })
})
