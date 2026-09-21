/**
 * What a page's taps reach for a haptic, and the grant every page route needs to get one.
 *
 * Inside the shell's WebView `expo-haptics` fakes an iOS haptic by clicking a hidden checkbox it
 * appends to `document.head`, which is what killed a long press on the worktree list (C1.9). So the
 * page's seam posts `native.haptics.trigger` instead and the app plays the device's own — and a
 * route that imports the seam without declaring `haptics` is a page whose taps go quiet, because
 * grants are resolved once from the route the shell opened.
 *
 * The scan has a control rather than an empty list: the same walk over the native sibling finds the
 * same five functions and no posting site, which is what says it can tell the two apart.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
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

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const read = (file) => readFileSync(join(mobileDir, file), 'utf8')

/** The route module behind each declared page route, which is what a closure is read from. */
const ROUTE_MODULES = new Map([
  ['/h/[hostId]', 'app/h/[hostId]/index.tsx'],
  ['/h/[hostId]/agent-history/[worktreeId]', 'app/h/[hostId]/agent-history/[worktreeId].tsx'],
  ['/h/[hostId]/tasks', 'app/h/[hostId]/tasks.tsx'],
  ['/h/[hostId]/files/[worktreeId]', 'app/h/[hostId]/files/[worktreeId].tsx'],
  ['/h/[hostId]/files/preview/[worktreeId]', 'app/h/[hostId]/files/preview/[worktreeId].tsx'],
  ['/h/[hostId]/source-control/[worktreeId]', 'app/h/[hostId]/source-control/[worktreeId].tsx'],
  ['/h/[hostId]/review/[worktreeId]', 'app/h/[hostId]/review/[worktreeId].tsx']
])

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

/**
 * The two siblings measured against each other, which is what makes "all five post" a number.
 *
 * The native file is the control: same five names, same walk, no posting site. Without it an empty
 * result and a file the scan could not read would report the same thing.
 */
describe('the two haptics siblings', () => {
  it('posts every kind the notify admits from the web sibling, and nothing more', () => {
    const kinds = bridgeHapticsKinds(read(HAPTICS_KINDS_MODULE), HAPTICS_KINDS_MODULE)
    expect(kinds).toHaveLength(5)
    const posted = hapticsPostedKinds(read(HAPTICS_SEAM), HAPTICS_SEAM)
    expect([...posted].sort()).toEqual([...kinds].sort())
  })

  it('finds five functions in the native sibling and no posting site at all', () => {
    const sites = hapticsTriggerSites(read(HAPTICS_NATIVE), HAPTICS_NATIVE)
    expect(sites).toHaveLength(5)
    expect(sites.filter((site) => site.kind !== null)).toEqual([])
  })

  it('exports the same five names from both, which is what makes one a substitution', () => {
    const names = (file) => hapticsTriggerSites(read(file), file).map((site) => site.name)
    expect(names(HAPTICS_SEAM)).toEqual(names(HAPTICS_NATIVE))
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
    expect(exported).toHaveLength(5)
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
      const closure = await mobileWebAppRouteClosure(mod)
      expect(closure.local).toContain(HAPTICS_SEAM)
      expect(closure.local).not.toContain(HAPTICS_NATIVE)
      // The precondition an assertion about a closure needs: the walk read a page, not nothing.
      expect(closure.local.length).toBeGreaterThan(250)
    })

    it.each([...ROUTE_MODULES])(
      'imports the seam from at least one module, so the grant is not idle: %s',
      async (_route, mod) => {
        const closure = await mobileWebAppRouteClosure(mod)
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
        const closure = await mobileWebAppRouteClosure(mod)
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
      // The map above is a hand list of route modules; this is what holds it to the declarations.
      expect([...ROUTE_MODULES.keys()].sort()).toEqual(
        MOBILE_WEB_PAGE_ROUTES.map((route) => route.pathname).sort()
      )
    })

    /**
     * What the notify costs a page to download: one module.
     *
     * Measured, not assumed: every page closure grew by exactly `bridge-haptics-notify.ts`, and it
     * arrives through `page-route-policy.ts` reading the grant token rather than through the seam,
     * whose own import of the kind type is erased. Its only dependency is `zod`, which the envelope
     * already put in every closure, so the module total moved by the same one.
     *
     * Pinned structurally rather than as a total: an absolute closure count is main's to move, and a
     * number that drifts for unrelated reasons is one nobody reads.
     */
    it('adds one module to a page closure, and only the two haptics modules are in it', async () => {
      for (const mod of ROUTE_MODULES.values()) {
        const closure = await mobileWebAppRouteClosure(mod)
        expect(closure.local.filter((file) => file.includes('haptics')).sort(), mod).toEqual([
          HAPTICS_KINDS_MODULE,
          HAPTICS_SEAM
        ])
        // The engine of the delta: the grant token is a value the route policy reads, and the
        // policy is in every page closure. Without this the +1 would have no stated cause.
        expect(closure.local, mod).toContain('src/mobile-web-shell/page-route-policy.ts')
      }
    })
  },
  240_000
)
