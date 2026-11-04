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

  it.each([null, 1, 'true'])('fails closed on a malformed CDP opaque flag (%s)', (opaque) => {
    expect(() =>
      cookieClearIdentitiesFromCdp(
        [{ cookie: chipsCookie, url: 'https://app.acme-chips.test/' }],
        [
          {
            name: 'chips-auth',
            value: 'keep-me',
            domain: 'app.acme-chips.test',
            path: '/',
            partitionKeyOpaque: opaque as unknown as boolean
          }
        ]
      )
    ).toThrow(/Could not snapshot cookie identity/)
  })

  it.each([
    { hasCrossSiteAncestor: true },
    { topLevelSite: 'not-a-site', hasCrossSiteAncestor: true },
    { topLevelSite: 'ftp://top.example', hasCrossSiteAncestor: true },
    { topLevelSite: 'https://top.example/path', hasCrossSiteAncestor: true }
  ])('fails closed when a CDP partition key has an invalid site (%o)', (partitionKey) => {
    expect(() =>
      cookieClearIdentitiesFromCdp(
        [{ cookie: chipsCookie, url: 'https://app.acme-chips.test/' }],
        [
          {
            name: 'chips-auth',
            value: 'keep-me',
            domain: 'app.acme-chips.test',
            path: '/',
            partitionKey
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

  it('indexes CDP cookies once instead of rescanning the jar for every cookie', () => {
    let domainReads = 0
    const count = 200
    const cookies = Array.from({ length: count }, (_, index) => ({
      cookie: { ...chipsCookie, domain: `host-${index}.example`, name: `cookie-${index}` },
      url: `https://host-${index}.example/`
    }))
    const cdpCookies = cookies.map(({ cookie }) => ({
      name: cookie.name,
      value: cookie.value,
      get domain() {
        domainReads += 1
        return cookie.domain
      },
      path: '/'
    }))

    expect(cookieClearIdentitiesFromCdp(cookies, cdpCookies)).toHaveLength(count)
    expect(domainReads).toBeLessThan(count * 6)
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
