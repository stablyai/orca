/**
 * Which route closures reach dictation's capture seam, and therefore which routes must be granted
 * the four audio verbs.
 *
 * A census rather than a hand list, because a grant row written by hand is a row that stops
 * agreeing with the closure the moment a screen moves: the rule below reads what each registered
 * page route actually reaches and holds its `grants` to it. Vacuous today — the session route is
 * the only closure that reaches the seam and `MOBILE_WEB_PAGE_ROUTES` does not carry it yet (C7.7
 * registers it) — so the control beside it applies the same rule to the session route module and
 * shows the rule failing without the four names.
 *
 * The closure also says what the seam took out of the page. Without its web half the bundler
 * resolves the native one, and the vendored `@orca/expo-two-way-audio` web stub lands in the
 * closure along with `expo-keep-awake` — which is what dictation on the page used to be: a module
 * answering denied microphone permission, and a wake lock that did nothing.
 *
 * Measured on this tree by moving `dictation-capture.web.ts` aside and walking the closure again:
 * `modules` 4,319 to 4,326 and `local` 977 to 976. Eight vendored modules re-enter — five from
 * `@orca/expo-two-way-audio` and three from `expo-keep-awake` — less the one local file that left,
 * which is the +7. The eight is the number below; the absolute counts are provenance and are not
 * asserted, because every merge of main moves them and a census that pinned them would fail for
 * reasons that are nobody's.
 *
 * So "absent" here is a fact about the seam and not about the census failing to look, and the
 * precondition is checked rather than assumed: both package names are resolved from the install, so
 * a substring that matches nothing fails as a typo rather than passing as an absence.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import { MobileWebBundleRouteSchema } from '../../src/shared/mobile-web-bundle/manifest-contract.ts'

/** The mobile install: the closure builds need it, and so does anything that imports a mobile
 *  module, because transforming one resolves `mobile/tsconfig.json` and its Expo base. */
const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

/** The seam, as the web build resolves it: `.web.ts` wins under the builder's resolveExtensions. */
const SEAM = 'src/platform/dictation-capture.web.ts'

/** The native half, which must resolve out of a page closure rather than sit in it unused. */
const NATIVE_SEAM = 'src/platform/dictation-capture.ts'

/** Every verb the seam calls. Named here so the rule below is the census's own answer and not a
 *  second list to keep true; `bridge-audio-verbs.test.ts` pins them against the verb table. */
const DICTATION_GRANTS = [
  'native.audio.start',
  'native.audio.read',
  'native.audio.stop',
  'native.wakelock.set'
]

/** Native modules the seam exists to keep out: importing either reaches a JSI binding, and their
 *  web builds are a denied microphone and a no-op wake lock. */
const NATIVE_AUDIO_MODULES = ['@orca/expo-two-way-audio', 'expo-keep-awake']

/**
 * How many of their modules re-enter the session closure when the seam's web half is moved aside.
 *
 * Recorded rather than measured here, because measuring it means walking the closure a second time
 * against a mutated tree. Five from `@orca/expo-two-way-audio` (its module, `core`, `events`,
 * `hooks` and the index) and three from `expo-keep-awake`. The docstring above carries the run.
 */
const NATIVE_AUDIO_MODULES_BEHIND_THE_SEAM = 8

const SESSION_PATHNAME = '/h/[hostId]/session/[worktreeId]'
const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

/**
 * One closure per route module, built once.
 *
 * Every call to `mobileWebAppRouteClosure` is a full esbuild metafile build of the route, and the
 * cases below ask about six modules across nine of them. Unmemoised this file did fifteen builds and
 * its CPU tipped two timing-sensitive neighbours in this shard over — a benchmark whose child had
 * 100 ms to write a pid file, and a census globbing a scratch tree another test was removing. Both
 * are fragile without this file and neither is reached by it; the load was the difference.
 */
const closures = new Map()

function closureOf(routeModule) {
  const built = closures.get(routeModule) ?? mobileWebAppRouteClosure(routeModule)
  closures.set(routeModule, built)
  return built
}

/** Resolved from `mobile/`, which is the tree the bundler resolves the closure out of: this suite
 *  runs at the repo root, where neither package is installed. */
function resolveFromMobile(specifier) {
  return createRequire(new URL('../../mobile/package.json', import.meta.url)).resolve(specifier)
}

/** The route module a registered pathname is served from, the way expo-router files are named. */
function routeModule(pathname) {
  const withoutRoot = pathname.replace(/^\//, '')
  const last = withoutRoot.split('/').at(-1)
  return last === '[hostId]' ? `app/${withoutRoot}/index.tsx` : `app/${withoutRoot}.tsx`
}

/** The grants a closure needs of the seam: all four, or none. A route granted three would record
 *  with the screen free to lock, and a lock mid-processing suspends the app and loses the
 *  transcript. */
function dictationGrantsNeeded(closure) {
  return closure.local.includes(SEAM) ? DICTATION_GRANTS : []
}

/**
 * The rule, as one function both the check and its control drive.
 *
 * Every grant a route's own closure needs and its entry does not name, as `<pathname> needs
 * <grant>`. One implementation, because a control that re-implemented the filter would prove the
 * control works and say nothing about the rule.
 */
async function grantsMissingForRoutes(routes) {
  const missing = []
  for (const route of routes) {
    const closure = await closureOf(routeModule(route.pathname))
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

    it('finds the seam in exactly one closure, which is the session route', async () => {
      const reaching = []
      for (const route of MOBILE_WEB_PAGE_ROUTES) {
        const closure = await closureOf(routeModule(route.pathname))
        if (closure.local.includes(SEAM)) {
          reaching.push(route.pathname)
        }
      }
      // None today: dictation lives on the session screen, and that route is not registered yet.
      // Which is why the rule above passes without a grant row moving, and why the control below
      // is what proves the rule can fail at all.
      expect(reaching).toEqual([])
      const session = await closureOf(SESSION)
      expect(session.local).toContain(SEAM)
    })

    it('reds the same rule when the session route is registered without them', async () => {
      // The control for the rule above, which is vacuous until C7.7 registers this route: the same
      // loop, driven over the entry C7.7 would write if it copied its neighbours' grants.
      expect(
        await grantsMissingForRoutes([
          { pathname: SESSION_PATHNAME, grants: ['navigate', 'storage'] }
        ])
      ).toEqual(DICTATION_GRANTS.map((grant) => `${SESSION_PATHNAME} needs ${grant}`))
      // And with all four named it passes, so the rule is satisfiable and not a wall.
      expect(
        await grantsMissingForRoutes([
          { pathname: SESSION_PATHNAME, grants: ['navigate', 'storage', ...DICTATION_GRANTS] }
        ])
      ).toEqual([])
      // Every one of the four is a name a manifest route may carry, which is the ruling-6a trap:
      // `native.audio.readChunk` is not a route that degrades to native, it is a bundle the phone
      // refuses entire.
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
        // The precondition for reading an absence: the package is installed, so the substring below
        // would match if the closure carried it. Without this the case passes on a typo.
        expect(() => resolveFromMobile(`${absent}/package.json`), absent).not.toThrow()
        expect(
          closure.modules.filter((module) => module.includes(`/${absent}/`)),
          absent
        ).toEqual([])
      }
      // The hook above the seam is still in the closure, so the absences above are the seam's work
      // and not dictation having left the page.
      expect(closure.local).toContain('src/hooks/use-mobile-dictation.ts')
      expect(closure.local).toContain('src/hooks/mobile-dictation-keep-awake.ts')
    })

    it('is big enough that finding nothing would mean something', async () => {
      const closure = await closureOf(SESSION)
      // The largest route of the series; a closure that collapsed would pass every rule above by
      // containing nothing to judge.
      expect(closure.local.length).toBeGreaterThan(900)
    })
  },
  240_000
)

describe('the census rule itself', () => {
  it('names a route module for every registered pathname', () => {
    expect(MOBILE_WEB_PAGE_ROUTES.map((route) => routeModule(route.pathname))).toEqual([
      'app/h/[hostId]/index.tsx',
      'app/h/[hostId]/agent-history/[worktreeId].tsx',
      'app/h/[hostId]/tasks.tsx',
      'app/h/[hostId]/files/[worktreeId].tsx',
      'app/h/[hostId]/files/preview/[worktreeId].tsx',
      'app/h/[hostId]/source-control/[worktreeId].tsx',
      'app/h/[hostId]/review/[worktreeId].tsx'
    ])
  })

  it('asks for all four grants or none, never a subset', () => {
    expect(dictationGrantsNeeded({ local: [SEAM] })).toEqual(DICTATION_GRANTS)
    expect(dictationGrantsNeeded({ local: ['src/platform/media-picker.web.ts'] })).toEqual([])
  })

  it('records what the seam keeps out, in the number that was measured', () => {
    expect(NATIVE_AUDIO_MODULES_BEHIND_THE_SEAM).toBe(8)
    expect(NATIVE_AUDIO_MODULES).toHaveLength(2)
  })

  /**
   * Gated on the mobile install, not merely deferred behind `import()`.
   *
   * A dynamic import defers *when* the module loads, not what loading costs. Vite transforms the
   * file at that moment and resolves the nearest `tsconfig.json` for it, which is
   * `mobile/tsconfig.json`, which extends `expo/tsconfig.base.json`. On the root-only shard that
   * package is not installed and the transform throws `TSConfckParseError` — reproduced by moving
   * `mobile/node_modules` aside and running this file from the repo root, which is what
   * `test / tests node 24 1/8` does. So the dependency gate is the only thing that keeps a mobile
   * module off that shard, and it is the same gate `describeClosure` above uses.
   */
  it.skipIf(!bundles)(
    'names only verbs the shell actually serves, read from its own table',
    async () => {
      // The failure this guards is the rule agreeing with itself: a list of four names the census
      // holds routes to, none of which the shell has a row for.
      const { BRIDGE_NATIVE_VERB_NAMES } =
        await import('../../mobile/src/mobile-web-shell/bridge/bridge-native-verbs.ts')
      expect(new Set(DICTATION_GRANTS).size).toBe(4)
      for (const grant of DICTATION_GRANTS) {
        expect(BRIDGE_NATIVE_VERB_NAMES, grant).toContain(grant)
        expect(
          MobileWebBundleRouteSchema.safeParse({ pathname: '/h', grants: [grant] }).success,
          grant
        ).toBe(true)
      }
    }
  )
})

/** Kept so a reader can find the tree this ran against without a machine path in the file. */
export const MOBILE_DIR = fileURLToPath(new URL('../../mobile/', import.meta.url))
