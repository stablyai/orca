import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS,
  MobileWebBundleRouteSchema
} from '../../src/shared/mobile-web-bundle/manifest-contract.ts'
import { resolveMobileWebPageRoutes } from './build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import { routePathnameFromKey } from './mobile-web-app/mobile-web-app-route-manifest.mjs'

// Test declared screens separately from bundle mechanics so route inventory can grow without coupling builder test size.

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

  // Synthetic optional-grant input checks member-by-member mapping; newly declared field must survive builder map before reaching phone.
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

  // Wide host-area grants union all served routes to retain in-page hops, within same per-route ceiling.
  it('bounds the aggregate required and optional grants by one route-grant ceiling', () => {
    const union = new Set(
      MOBILE_WEB_PAGE_ROUTES.flatMap((route) => [...route.grants, ...(route.optionalGrants ?? [])])
    )
    expect(union.size).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
  })

  it('holds the optional lane to the manifest grammar and the ceiling over the union', () => {
    // Optional/required tokens share schema grammar and combined bound; independent bounds could exceed manifest ceiling.
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
    // Declared-but-unbundled route opens page then paints Unmatched; catch mismatch at declaration.
    expect(() =>
      resolveMobileWebPageRoutes(
        ['./h/[hostId]/index.tsx'],
        [{ pathname: '/h/[hostId]/gone', grants: [] }]
      )
    ).toThrow('has no module in the bundle')
  })
})
