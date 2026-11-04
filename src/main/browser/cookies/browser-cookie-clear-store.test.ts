import { describe, expect, it } from 'vitest'
import type { Cookie } from 'electron'
import {
  cdpSetCookieParamsFromIdentity,
  cookieClearIdentitiesFromCdp
} from './browser-cookie-clear-store'

const chipsCookie: Cookie = {
  domain: 'app.acme-chips.test',
  name: 'chips-auth',
  path: '/',
  secure: true,
  sameSite: 'no_restriction',
  value: 'keep-me'
}

describe('cookie clear CDP identities', () => {
  it('captures a CHIPS partition key for restore and never invents one', () => {
    const identities = cookieClearIdentitiesFromCdp(
      [{ cookie: chipsCookie, url: 'https://app.acme-chips.test/' }],
      [
        {
          name: 'chips-auth',
          value: 'keep-me',
          domain: 'app.acme-chips.test',
          path: '/',
          secure: true,
          sameSite: 'None',
          partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
        }
      ]
    )

    expect(identities).toEqual([
      expect.objectContaining({
        name: 'chips-auth',
        partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
      })
    ])
    expect(cdpSetCookieParamsFromIdentity(identities[0])).toEqual(
      expect.objectContaining({
        name: 'chips-auth',
        sameSite: 'None',
        partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
      })
    )
  })

  it('fails closed when CDP cannot identify a removable cookie', () => {
    expect(() =>
      cookieClearIdentitiesFromCdp(
        [{ cookie: chipsCookie, url: 'https://app.acme-chips.test/' }],
        []
      )
    ).toThrow(/Could not snapshot cookie identity/)
  })

  it('fails closed when a partitioned CDP identity omits its ancestor bit', () => {
    expect(() =>
      cookieClearIdentitiesFromCdp(
        [{ cookie: chipsCookie, url: 'https://app.acme-chips.test/' }],
        [
          {
            name: 'chips-auth',
            value: 'keep-me',
            domain: 'app.acme-chips.test',
            path: '/',
            partitionKey: { topLevelSite: 'https://top.example' }
          }
        ]
      )
    ).toThrow(/Could not snapshot cookie identity/)
  })

  it('fails closed instead of making an opaque CDP partition restorable as unpartitioned', () => {
    expect(() =>
      cookieClearIdentitiesFromCdp(
        [{ cookie: chipsCookie, url: 'https://app.acme-chips.test/' }],
        [
          {
            name: 'chips-auth',
            value: 'keep-me',
            domain: 'app.acme-chips.test',
            path: '/',
            partitionKeyOpaque: true
          }
        ]
      )
    ).toThrow(/Could not snapshot cookie identity/)
  })

  it('keeps host-only and domain cookies with the same coordinates distinct', () => {
    const cookies: Cookie[] = [
      { ...chipsCookie, domain: 'example.com', hostOnly: true, name: 'twin', value: 'host' },
      { ...chipsCookie, domain: '.example.com', hostOnly: false, name: 'twin', value: 'domain' }
    ]
    const identities = cookieClearIdentitiesFromCdp(
      cookies.map((cookie) => ({ cookie, url: 'https://example.com/' })),
      [
        { name: 'twin', value: 'host', domain: 'example.com', path: '/' },
        { name: 'twin', value: 'domain', domain: '.example.com', path: '/' }
      ]
    )

    expect(identities).toEqual([
      expect.objectContaining({ value: 'host', domain: 'example.com', hostOnly: true }),
      expect.objectContaining({ value: 'domain', domain: '.example.com', hostOnly: false })
    ])
    expect(cdpSetCookieParamsFromIdentity(identities[0])).not.toHaveProperty('domain')
    expect(cdpSetCookieParamsFromIdentity(identities[1])).toHaveProperty('domain', '.example.com')
  })

  it('does not turn an unspecified SameSite policy into explicit Lax', () => {
    expect(
      cdpSetCookieParamsFromIdentity({
        url: 'https://example.com/',
        name: 'unspecified',
        value: 'value',
        sameSite: 'unspecified'
      })
    ).not.toHaveProperty('sameSite')
  })
})
