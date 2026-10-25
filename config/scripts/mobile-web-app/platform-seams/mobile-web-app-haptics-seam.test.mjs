/**
 * What a page's taps reach for a haptic, and the grant every page route needs to get one.
 *
 * Inside the shell's WebView `expo-haptics` fakes an iOS haptic by clicking a hidden checkbox it
 * appends to `document.head`, which is what killed a long press on the worktree list (C1.9). So the
 * page's seam posts `native.haptics.trigger` instead and the app plays the device's own — and a
 * route that imports the seam without declaring `haptics` is a page whose taps go quiet, because
 * grants are resolved once from the route the shell opened.
 *
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../../build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../../mobile-web-page-routes.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  PAGE_ROUTE_MODULES,
  pageRouteModulesCoverTheManifest
} from '../mobile-web-app-page-route-modules.mjs'
import {
  HAPTICS_KINDS_MODULE,
  HAPTICS_NATIVE,
  HAPTICS_SEAM,
  bridgeHapticsKinds,
  hapticsImportedNames,
  hapticsPostedKinds,
  hapticsSeamImporters,
  hapticsTriggerSites
} from './mobile-web-app-haptics-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const read = (file) => readFileSync(join(mobileDir, file), 'utf8')

/** The route module behind each declared page route, shared with the screencast-lane census. */
const ROUTE_MODULES = PAGE_ROUTE_MODULES

// These cases read the same source tree; keep each route's real closure once.
const closures = new Map()
async function closureOf(module) {
  const built = closures.get(module) ?? mobileWebAppRouteClosure(module)
  closures.set(module, built)
  return structuredClone(await built)
}

const HAPTICS_GRANT = 'haptics'

/** The shell's mapping from a notify kind to one of the app's own functions. */
const SHELL_MAPPING = 'src/mobile-web-shell/page-haptics.ts'

describe('the seam reader', () => {
  it('names the kind each exported trigger posts', () => {
    expect(
      hapticsTriggerSites(
        [
          'let post = () => false',
          'export function publishHapticsNotifier(notify) {',
          '  post = notify',
          '}',
          "export function triggerSelection() { post('selection') }"
        ].join('\n'),
        'haptics.web.ts'
      )
    ).toEqual([{ name: 'triggerSelection', line: 5, kind: 'selection' }])
  })

  it('reads the binding the publisher assigns rather than a name called post', () => {
    // Keyed on `post`, renaming the local would turn every posting site into a non-posting one and
    // leave this census green on a page whose taps buzz for nothing.
    expect(
      hapticsPostedKinds(
        [
          'let ask = () => false',
          'export function publishHapticsNotifier(notify) { ask = notify }',
          "export function triggerError() { ask('error') }"
        ].join('\n'),
        'haptics.web.ts'
      )
    ).toEqual(['error'])
  })

  it('reports a function that posts nothing as a site with no kind', () => {
    expect(
      hapticsTriggerSites('export function triggerSelection() {}\n', 'haptics.web.ts')
    ).toEqual([{ name: 'triggerSelection', line: 1, kind: null }])
  })

  it('reports no kind for a function that posts one it computed, which nothing can pin', () => {
    expect(
      hapticsPostedKinds(
        [
          'let post = () => false',
          'export function publishHapticsNotifier(notify) { post = notify }',
          'export function triggerSelection(kind) { post(kind) }'
        ].join('\n'),
        'haptics.web.ts'
      )
    ).toEqual([])
  })

  it('reports no kind for a function that posts twice, which is two taps for one gesture', () => {
    expect(
      hapticsPostedKinds(
        [
          'let post = () => false',
          'export function publishHapticsNotifier(notify) { post = notify }',
          "export function triggerSelection() { post('selection'); post('success') }"
        ].join('\n'),
        'haptics.web.ts'
      )
    ).toEqual([])
  })

  it('leaves alone a trigger the module does not export', () => {
    expect(
      hapticsTriggerSites(
        [
          'let post = () => false',
          'export function publishHapticsNotifier(notify) { post = notify }',
          "function triggerLocal() { post('selection') }"
        ].join('\n'),
        'haptics.web.ts'
      )
    ).toEqual([])
  })

  it('ignores the seam named inside a comment or a string, which text matching cannot', () => {
    expect(
      hapticsPostedKinds(
        [
          'let post = () => false',
          'export function publishHapticsNotifier(notify) { post = notify }',
          "// export function triggerSelection() { post('selection') }",
          'const hint = "post(\'success\')"'
        ].join('\n'),
        'haptics.web.ts'
      )
    ).toEqual([])
  })

  it('reads the kinds off the tuple that declares them', () => {
    expect(bridgeHapticsKinds("export const BRIDGE_HAPTICS_KINDS = ['a', 'b'] as const\n")).toEqual(
      ['a', 'b']
    )
    // A mention is not a declaration, which is why this is parsed rather than matched.
    expect(bridgeHapticsKinds("// BRIDGE_HAPTICS_KINDS = ['a']\n")).toEqual([])
  })
})

describe('the two haptics siblings', () => {
  it('posts every kind the notify admits from the web sibling, and nothing more', () => {
    const kinds = bridgeHapticsKinds(read(HAPTICS_KINDS_MODULE), HAPTICS_KINDS_MODULE)
    expect(kinds.length).toBeGreaterThan(0)
    const posted = hapticsPostedKinds(read(HAPTICS_SEAM), HAPTICS_SEAM)
    expect([...posted].sort()).toEqual([...kinds].sort())
  })

  /**
   * The third direction, which no type in the app states.
   *
   * The shell's table refuses a kind with no row and a row naming a function that does not exist,
   * both at compile time. It says nothing about a haptic `haptics.ts` grows with no kind of its own,
   * which would be one the page can never ask for however many rows the table has.
   */
  it('maps every function the app exports from the shell side, so none is unreachable', () => {
    const exported = hapticsTriggerSites(read(HAPTICS_NATIVE), HAPTICS_NATIVE).map(
      (site) => site.name
    )
    expect(exported.length).toBeGreaterThan(0)
    expect(hapticsImportedNames(read(SHELL_MAPPING), SHELL_MAPPING)).toEqual([...exported].sort())
  })
})

describe('the imported-name reader', () => {
  it('names what a module takes from the app haptics', () => {
    expect(
      hapticsImportedNames(
        "import { triggerError, triggerSuccess } from '../platform/haptics'\n",
        'page-haptics.ts'
      )
    ).toEqual(['triggerError', 'triggerSuccess'])
  })

  it('reads the imported name and not the local one, a renamed import being the same export', () => {
    expect(
      hapticsImportedNames(
        "import { triggerError as boom } from '../platform/haptics'\n",
        'page-haptics.ts'
      )
    ).toEqual(['triggerError'])
  })

  it('leaves alone an import of the web sibling or of something else entirely', () => {
    expect(
      hapticsImportedNames(
        [
          "import { triggerError } from '../platform/haptics.web'",
          "import { triggerSuccess } from './other-haptics'",
          "// import { triggerEdgeBump } from '../platform/haptics'"
        ].join('\n'),
        'page-haptics.ts'
      )
    ).toEqual([])
  })
})

describeClosure(
  'every page route closure and the haptics seam',
  () => {
    it.each([...ROUTE_MODULES])('resolves the seam to the web sibling: %s', async (_route, mod) => {
      const closure = await closureOf(mod)
      expect(closure.local).toContain(HAPTICS_SEAM)
      expect(closure.local).not.toContain(HAPTICS_NATIVE)
    })

    it.each([...ROUTE_MODULES])(
      'imports the seam from at least one module, so the grant is not idle: %s',
      async (_route, mod) => {
        const closure = await closureOf(mod)
        expect(hapticsSeamImporters(mobileDir, closure).length).toBeGreaterThan(0)
      }
    )

    /**
     * The grant list derived from the closures rather than written by hand.
     *
     * Grants are resolved once, from the route the shell opened, and carried for the life of the
     * session. A route that imports the seam and declares nothing is a page whose taps are silent
     * with nothing on screen to say why.
     *
     * The cost of the answer being every route: `implementedPageRoutes` filters on
     * `grants.every(implementsGrant)`, so against a shell that does not carry the token no page
     * route is served at all and the phone renders the native screens. The mechanism is pinned in
     * `mobile/src/mobile-web-shell/page-route-policy.test.ts`.
     */
    it('declares haptics on exactly the routes whose closure reaches the seam', async () => {
      const reaching = []
      for (const [route, mod] of ROUTE_MODULES) {
        const closure = await closureOf(mod)
        if (hapticsSeamImporters(mobileDir, closure).length > 0) {
          reaching.push(route)
        }
      }
      expect(reaching.length).toBeGreaterThan(0)
      const declared = MOBILE_WEB_PAGE_ROUTES.filter((route) =>
        route.grants.includes(HAPTICS_GRANT)
      ).map((route) => route.pathname)
      expect([...declared].sort()).toEqual([...reaching].sort())
    })

    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      // The shared map is a hand list of route modules; this is what holds it to the declarations.
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })
  },
  240_000
)
