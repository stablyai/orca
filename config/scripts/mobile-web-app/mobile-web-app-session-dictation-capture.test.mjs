// Derive dictation grants from registered routes’ real capture-seam closures; retain missing-grant control to prove rule can fail.
// Web seam removes native audio/keep-awake: their web stubs deny microphone and do nothing, rather than capturing through shell.
// Resolve package names before absence checks to catch typos; assert eight excluded vendored modules, not drifting total closure size.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../mobile-web-page-routes.mjs'
import { PAGE_ROUTE_MODULES } from './mobile-web-app-page-route-modules.mjs'
import { MobileWebBundleRouteSchema } from '../../../src/shared/mobile-web-bundle/manifest-contract.ts'

// Gate mobile transforms too: nearest tsconfig extends Expo package absent from root-only shards.
const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

const SEAM = 'src/platform/dictation-capture.web.ts'

const NATIVE_SEAM = 'src/platform/dictation-capture.ts'

const DICTATION_GRANTS = ['native.audio.start', 'native.audio.read', 'native.audio.stop']

// Native modules reach JSI; browser substitutes denied microphone and no-op wake lock.
const NATIVE_AUDIO_MODULES = ['@orca/expo-two-way-audio', 'expo-keep-awake']

const SESSION_PATHNAME = '/h/[hostId]/session/[worktreeId]'
const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

// Memoize full esbuild closures: repeated builds once starved timing-sensitive shard neighbors with no dependency on this suite.
const closures = new Map()

function closureOf(routeModule) {
  const built = closures.get(routeModule) ?? mobileWebAppRouteClosure(routeModule)
  closures.set(routeModule, built)
  return built
}

// Resolve from mobile install as bundler does; root install lacks both packages.
function resolveFromMobile(specifier) {
  return createRequire(new URL('../../../mobile/package.json', import.meta.url)).resolve(specifier)
}

// Audio grants are all-or-none: partial set could open microphone without draining or stopping it.
function dictationGrantsNeeded(closure) {
  return closure.local.includes(SEAM) ? DICTATION_GRANTS : []
}

// Share missing-grant rule with negative control; reimplementing control would only prove its own filter.
async function grantsMissingForRoutes(routes) {
  const missing = []
  for (const route of routes) {
    const module = PAGE_ROUTE_MODULES.get(route.pathname)
    if (module === undefined) {
      throw new Error(`No route module for ${route.pathname}`)
    }
    const closure = await closureOf(module)
    for (const grant of dictationGrantsNeeded(closure)) {
      if (!route.grants.includes(grant)) {
        missing.push(`${route.pathname} needs ${grant}`)
      }
    }
  }
  return missing
}

describeClosure(
  'the routes that reach dictation capture',
  () => {
    it('holds every registered page route to the grants its own closure needs', async () => {
      expect(await grantsMissingForRoutes(MOBILE_WEB_PAGE_ROUTES)).toEqual([])
    })

    it('reds the same rule when the session route is registered without them', async () => {
      // Drive same rule over under-granted entry to prove missing grants are detected.
      expect(
        await grantsMissingForRoutes([
          { pathname: SESSION_PATHNAME, grants: ['navigate', 'storage'] }
        ])
      ).toEqual(DICTATION_GRANTS.map((grant) => `${SESSION_PATHNAME} needs ${grant}`))
      // Complete-grant positive control proves rule is satisfiable.
      expect(
        await grantsMissingForRoutes([
          { pathname: SESSION_PATHNAME, grants: ['navigate', 'storage', ...DICTATION_GRANTS] }
        ])
      ).toEqual([])
      // Verify every token is manifest-legal; obsolete native.audio.readChunk rejects entire bundle, not just route.
      expect(
        MobileWebBundleRouteSchema.safeParse({
          pathname: SESSION_PATHNAME,
          grants: DICTATION_GRANTS
        }).success
      ).toBe(true)
    })

    it('carries the seam and not the native audio chain it stands in for', async () => {
      const closure = await closureOf(SESSION)
      expect(closure.local).toContain(SEAM)
      expect(closure.local).not.toContain(NATIVE_SEAM)
      for (const absent of NATIVE_AUDIO_MODULES) {
        // Resolve installed package before substring absence assertion so a typo cannot pass.
        expect(() => resolveFromMobile(`${absent}/package.json`), absent).not.toThrow()
        expect(
          closure.modules.filter((module) => module.includes(`/${absent}/`)),
          absent
        ).toEqual([])
      }
      // Require hook remains reachable so excluded native modules are seam’s work.
      expect(closure.local).toContain('src/hooks/use-mobile-dictation.ts')
      expect(closure.local).toContain('src/hooks/mobile-dictation-audio-chunk.ts')
    })
  },
  240_000
)
