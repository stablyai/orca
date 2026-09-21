import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] },
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'haptics']
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
