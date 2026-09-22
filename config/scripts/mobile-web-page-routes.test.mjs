import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MobileWebBundleRouteSchema } from '../../src/shared/mobile-web-bundle/manifest-contract.ts'
import {
  buildMobileWebAppBundle,
  resolveMobileWebPageRoutes
} from './build-mobile-web-app-bundle.mjs'
import { computeMobileWebBundleBuildId } from './build-mobile-web-bundle.mjs'
import {
  collectMobileWebAppRouteKeys,
  routePathnameFromKey
} from './mobile-web-app-route-manifest.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

/**
 * Which screens this desktop declares as page routes, and whether the bundle can render each.
 *
 * Split out of `build-mobile-web-app-bundle.test.mjs`, which is about how the bundle is built: this
 * is about what it declares, and the list grows once per registered domain while that file does not.
 * Keeping them together put the growing list against that file's 600-line cap, where the next route
 * to register would have had to choose between a lint fence and a split it did not ask for.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

// The sharded `test` job does not install mobile dependencies, so anything that runs esbuild over
// the route tree is skipped there and run for real in pr.yml's mobile_web_app job.
const itBundling = mobileWebAppDependenciesPresent() ? it : it.skip

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-page-routes-test-'))
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Every page route this bundle declares, written out rather than read from the source that
 * produces it: the point is to pin the list, and comparing the manifest to its own input would
 * pass whatever that input became. Shared by the assertions below, which read it two ways: what
 * the route tree resolves to, and what the built manifest actually carries.
 */
const EXPECTED_PAGE_ROUTES = [
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'externalLink', 'haptics'] },
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  {
    pathname: '/h/[hostId]/files/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  {
    pathname: '/h/[hostId]/source-control/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  {
    pathname: '/h/[hostId]/review/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  {
    pathname: '/h/[hostId]/session/[worktreeId]',
    grants: [
      'navigate',
      'storage',
      'externalLink',
      'haptics',
      'screencastBinary',
      'native.clipboard.write',
      'native.clipboard.read',
      'native.media.pick',
      'native.media.read',
      'native.media.release',
      'native.audio.start',
      'native.audio.read',
      'native.audio.stop'
    ],
    // The one optional grant in the list (C8.1): the HTML preview's links, hidden rather than dead
    // against a shell that cannot open one.
    optionalGrants: ['externalNavigation']
  }
]

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

  it('declares only routes the bundle has a module for', async () => {
    const keys = await collectMobileWebAppRouteKeys(appDir)
    expect(resolveMobileWebPageRoutes(keys)).toEqual(EXPECTED_PAGE_ROUTES)
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

  itBundling(
    'reaches the built manifest, where the build id does not move for it',
    async () => {
      await withScratch(async (scratch) => {
        const { manifest } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
        expect(manifest.routes).toEqual(EXPECTED_PAGE_ROUTES)
        // The routes are derived from the same tree the script is built from, so the assets
        // already decide them and the id has no reason to carry them as well.
        expect(manifest.buildId).toBe(computeMobileWebBundleBuildId(manifest.assets))
      })
    },
    240_000
  )
})
