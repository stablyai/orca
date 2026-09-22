/**
 * The six grants that were pinned only by the list they were copied from (ruling 33.3).
 *
 * `haptics`, `screencastBinary`, `externalNavigation` and the four audio grants already have
 * censuses of their own; these six did not, so removing any of them from a manifest entry reddened
 * nothing. Each row below gets its own named case, and each case's control is the same rule driven
 * over the entry that route would have had with the grant struck out.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  PAGE_ROUTE_MODULES,
  pageRouteModulesCoverTheManifest
} from './mobile-web-app-page-route-modules.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import {
  PAGE_GRANT_CALL_SITES,
  grantCallSites,
  grantsMissingForRow,
  grantsNeeded,
  moduleReachesGrantRow
} from './mobile-web-app-page-grant-call-sites.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = '/h/[hostId]/session/[worktreeId]'

/** Memoised: every case below walks all eight, and a closure is a bundle the walk builds. */
const closures = new Map()

function closureOf(pathname) {
  const mod = PAGE_ROUTE_MODULES.get(pathname)
  if (mod === undefined) {
    throw new Error(`${pathname} has no route module, so no closure can be read for it`)
  }
  const held = closures.get(pathname) ?? mobileWebAppRouteClosure(mod)
  closures.set(pathname, held)
  return held
}

describe('the call-site reader', () => {
  const navigate = PAGE_GRANT_CALL_SITES[0]
  const storage = PAGE_GRANT_CALL_SITES[1]

  it('counts a call and not an import that never calls it', () => {
    expect(
      moduleReachesGrantRow(
        "import { useRouteHandoff } from '../navigation/route-handoff'\nexport { useRouteHandoff }\n",
        'a.ts',
        navigate
      )
    ).toBe(false)
    expect(
      moduleReachesGrantRow(
        "import { useRouteHandoff } from '../navigation/route-handoff'\nconst r = useRouteHandoff()\n",
        'a.ts',
        navigate
      )
    ).toBe(true)
  })

  it('ignores the seam named in a comment or a string, which text matching cannot', () => {
    expect(
      moduleReachesGrantRow(
        ['// const r = useRouteHandoff()', 'const hint = "useRouteHandoff()"'].join('\n'),
        'a.ts',
        navigate
      )
    ).toBe(false)
  })

  it('reads a .tsx file as TSX, so nothing after the first element is swallowed', () => {
    expect(
      moduleReachesGrantRow(
        ['export const view = <View />', 'export const use = () => useRouteHandoff()'].join('\n'),
        'a.tsx',
        navigate
      )
    ).toBe(true)
  })

  it('counts the substituted module as reached when it is imported at all', () => {
    expect(
      moduleReachesGrantRow(
        "import AsyncStorage from '@react-native-async-storage/async-storage'\n",
        'a.ts',
        storage
      )
    ).toBe(true)
    expect(
      moduleReachesGrantRow("import AsyncStorage from './other-storage'\n", 'a.ts', storage)
    ).toBe(false)
  })

  it('names six rows covering eight grants, none of them a grant another census owns', () => {
    const grants = PAGE_GRANT_CALL_SITES.flatMap((row) => row.grants)
    expect(PAGE_GRANT_CALL_SITES).toHaveLength(6)
    expect(grants).toEqual([
      'navigate',
      'storage',
      'externalLink',
      'native.clipboard.write',
      'native.clipboard.read',
      'native.media.pick',
      'native.media.read',
      'native.media.release'
    ])
    for (const owned of [
      'haptics',
      'screencastBinary',
      'externalNavigation',
      'native.audio.start'
    ]) {
      expect(grants).not.toContain(owned)
    }
  })
})

describeClosure(
  'what each page route reaches, against what it declared',
  () => {
    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })

    /**
     * One case per row, named after its own grants.
     *
     * Per row rather than one check over the manifest, because the point is attribution: striking
     * `native.clipboard.read` out of an entry has to red a case that says so, and a single
     * whole-manifest assertion reds the same way whichever grant went missing.
     */
    it.each(PAGE_GRANT_CALL_SITES.map((row) => [row.grants.join(' + '), row]))(
      'declares %s on every registered route whose own call sites reach it',
      async (_name, row) => {
        expect(
          await grantsMissingForRow(mobileDir, MOBILE_WEB_PAGE_ROUTES, closureOf, row)
        ).toEqual([])
      }
    )

    /**
     * The control for each of those, self-contained on purpose.
     *
     * Built from what the session route's own closure reaches rather than from what its entry
     * declares, so a case stays green whatever the manifest says and reds only when the rule stops
     * working. Reading the manifest here instead would make every row red as soon as any one grant
     * went missing, which is the attribution the case above exists to give.
     */
    it.each(PAGE_GRANT_CALL_SITES.map((row) => [row.grants.join(' + '), row]))(
      'reds the session route when it is registered without %s',
      async (_name, row) => {
        const needed = grantsNeeded(mobileDir, await closureOf(SESSION))
        expect(needed, 'the session route reaches this row').toEqual(
          expect.arrayContaining(row.grants)
        )
        const entry = (grants) => [{ pathname: SESSION, grants }]
        // Declaring everything it reaches passes, so each case is a rule and not a wall.
        expect(await grantsMissingForRow(mobileDir, entry(needed), closureOf, row)).toEqual([])
        const without = needed.filter((grant) => !row.grants.includes(grant))
        expect(await grantsMissingForRow(mobileDir, entry(without), closureOf, row)).toEqual(
          row.grants.map((grant) => `${SESSION} needs ${grant}`)
        )
      }
    )

    it('reaches every one of the eight through the session route, and names where', async () => {
      const closure = await closureOf(SESSION)
      // The precondition an assertion about a closure needs: the walk read a page, not nothing.
      expect(closure.local.length).toBeGreaterThan(250)
      expect(grantsNeeded(mobileDir, closure)).toEqual(
        PAGE_GRANT_CALL_SITES.flatMap((row) => row.grants)
      )
      for (const row of PAGE_GRANT_CALL_SITES) {
        expect(
          grantCallSites(mobileDir, closure, row).length,
          row.grants.join(' + ')
        ).toBeGreaterThan(0)
      }
    })

    it('finds the clipboard reader and the media picker on the session route alone', async () => {
      const readerRow = PAGE_GRANT_CALL_SITES[4]
      const mediaRow = PAGE_GRANT_CALL_SITES[5]
      const reaching = { reader: [], media: [] }
      for (const pathname of PAGE_ROUTE_MODULES.keys()) {
        const closure = await closureOf(pathname)
        if (grantCallSites(mobileDir, closure, readerRow).length > 0) {
          reaching.reader.push(pathname)
        }
        if (grantCallSites(mobileDir, closure, mediaRow).length > 0) {
          reaching.media.push(pathname)
        }
      }
      // Both are the session screen's and nowhere else's, which is why no other route carries them.
      expect(reaching.reader).toEqual([SESSION])
      expect(reaching.media).toEqual([SESSION])
    })
  },
  240_000
)
