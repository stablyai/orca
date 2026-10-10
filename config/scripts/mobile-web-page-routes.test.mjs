import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS,
  MobileWebBundleRouteSchema
} from '../../src/shared/mobile-web-bundle/manifest-contract.ts'
import { resolveMobileWebPageRoutes } from './build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import { routePathnameFromKey } from './mobile-web-app-route-manifest.mjs'

/**
 * Which screens this desktop declares as page routes, and whether the bundle can render each.
 *
 * Split out of `build-mobile-web-app-bundle.test.mjs`, which is about how the bundle is built: this
 * is about what it declares, and the list grows once per registered domain while that file does not.
 * Keeping them together put the growing list against that file's 600-line cap, where the next route
 * to register would have had to choose between a lint fence and a split it did not ask for.
 */

describe('the page routes the manifest declares', () => {
  it('turns a route key into the URL pattern expo-router gives it', () => {
    expect(routePathnameFromKey('./h/[hostId]/index.tsx')).toBe('/h/[hostId]')
    expect(routePathnameFromKey('./h/[hostId]/tasks.tsx')).toBe('/h/[hostId]/tasks')
    expect(routePathnameFromKey('./h/[hostId]/session/[worktreeId].tsx')).toBe(
      '/h/[hostId]/session/[worktreeId]'
    )
  })

  it('answers null for a layout, which is not a screen anyone navigates to', () => {
    expect(routePathnameFromKey('./h/_layout.tsx')).toBeNull()
    expect(routePathnameFromKey('./h/[hostId]/_layout.tsx')).toBeNull()
  })

  /**
   * The optional lane through the builder, which drops what it does not name.
   *
   * `resolveMobileWebPageRoutes` maps each declaration member by member, so a field the declaration
   * grows reaches a phone only once this map names it. Driven on an input of its own rather than on
   * the real list, so the case stays a rule about the map whatever the declarations become.
   */
  it('carries an optional grant list through, and writes no key for a route without one', () => {
    expect(
      resolveMobileWebPageRoutes(
        ['./h/[hostId]/index.tsx', './h/[hostId]/tasks.tsx'],
        [
          {
            pathname: '/h/[hostId]',
            grants: ['navigate'],
            optionalGrants: ['externalNavigation']
          },
          { pathname: '/h/[hostId]/tasks', grants: ['navigate'], optionalGrants: [] }
        ]
      )
    ).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate'], optionalGrants: ['externalNavigation'] },
      { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
    ])
  })

  it('carries the host-area declaration through, and writes no key where there is none', () => {
    expect(
      resolveMobileWebPageRoutes(
        ['./h/[hostId]/index.tsx', './h/[hostId]/tasks.tsx'],
        [
          { pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: true },
          { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
        ]
      )
    ).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: true },
      { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
    ])
  })

  /**
   * The wide iPad's host-area session is granted every served route's list, so its in-page hops
   * stay in the page. Bounded by the per-route ceiling too, so that grant never outgrows one route's.
   */
  it('declares the host area on the host route alone, under one route-grant ceiling', () => {
    expect(
      MOBILE_WEB_PAGE_ROUTES.filter((route) => route.canOwnHostArea).map((route) => route.pathname)
    ).toEqual(['/h/[hostId]'])
    const union = new Set(
      MOBILE_WEB_PAGE_ROUTES.flatMap((route) => [...route.grants, ...(route.optionalGrants ?? [])])
    )
    expect(union.size).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
  })

  it('holds the optional lane to the manifest grammar and the ceiling over the union', () => {
    // The declaration is checked against `MobileWebBundleRouteSchema` when the manifest is written,
    // so this is that schema's rule read from the builder's side: a name the required lane refuses
    // is refused here, and the two lists are bounded together rather than one at a time.
    const withOptional = (optionalGrants, grants = []) =>
      MobileWebBundleRouteSchema.safeParse({ pathname: '/h/[hostId]', grants, optionalGrants })
        .success
    expect(withOptional(['externalNavigation'])).toBe(true)
    expect(withOptional(['native.externalNavigation'])).toBe(false)
    const names = (count, prefix) =>
      Array.from({ length: count }, (_value, index) => `${prefix}${String(index)}`)
    expect(withOptional(names(8, 'opt'), names(8, 'req'))).toBe(true)
    expect(withOptional(names(9, 'opt'), names(8, 'req'))).toBe(false)
  })

  it('fails the build on a declaration the bundle cannot render', () => {
    // The mismatch reaches a phone as a route the shell opens the page for and the page then
    // paints as Unmatched. This is the only place whoever wrote the declaration can see it.
    expect(() =>
      resolveMobileWebPageRoutes(
        ['./h/[hostId]/index.tsx'],
        [{ pathname: '/h/[hostId]/gone', grants: [] }]
      )
    ).toThrow('has no module in the bundle')
  })
})
