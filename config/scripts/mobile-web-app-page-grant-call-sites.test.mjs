/**
 * The eight grants this file pins, in six rows covering them (ruling 33.3).
 *
 * `haptics`, `screencastBinary`, `externalNavigation` and the three audio grants already have
 * censuses of their own; these eight did not, so removing any of them from a manifest entry
 * reddened nothing. Each row below gets its own named case, and each case's control is the same
 * rule driven over the entry that route would have had with the grant struck out.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  PAGE_ROUTE_MODULES,
  pageRouteModulesCoverTheManifest
} from './mobile-web-app-page-route-modules.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import { spelledCountsAgainstTables } from './spelled-count-census.mjs'
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

const scriptsDir = import.meta.dirname

const sessionGrants = MOBILE_WEB_PAGE_ROUTES.filter((route) => route.pathname === SESSION).flatMap(
  (route) => route.grants
)
const pinnedHere = PAGE_GRANT_CALL_SITES.flatMap((row) => row.grants)
const pinnedHereForSession = pinnedHere.filter((grant) => sessionGrants.includes(grant))
const sessionOptionalGrants = MOBILE_WEB_PAGE_ROUTES.filter(
  (route) => route.pathname === SESSION
).flatMap((route) => route.optionalGrants ?? [])
const pinnedElsewhere = sessionGrants.filter((grant) => !pinnedHere.includes(grant))
const censusedElsewhere = [...sessionGrants, ...sessionOptionalGrants].filter(
  (grant) => !pinnedHere.includes(grant)
)

/**
 * The split both this file and its census state in prose, counted off the two tables instead.
 *
 * The rows here pin some of the session route's grants and named censuses pin the rest; the
 * sentences that say how many were written when a fourteenth grant existed and did not move when
 * #22072 removed it.
 *
 * Two counts, and which one a row takes is what its sentence is about. Exactly one row takes the
 * intersection: the `.mjs` sentence for how many of the session route's grants these rows cover,
 * which a row pinning a grant no route declares -- the shell can serve a verb before a screen asks
 * for it -- would otherwise make the census demand a comment overstate the session route's list.
 *
 * Of the rows that could take either, every other one counts the rows here, the title about
 * reaching them through the session route included. That title names the session route but is not
 * a claim about it: the assertion under it compares `grantsNeeded` with every row's grants, so it
 * has to move when the rows move and not when the route does. A census holding it at the
 * intersection would have kept the title below the assertion it heads. The remaining rows count
 * neither: they read the route's own list, or the grants on it that no row pins.
 *
 * The rows read the whole file, titles included: a count in a JSDoc and the same count in an `it`
 * title go stale together, and pinning only the first leaves a green suite describing itself
 * wrongly to whoever reads the run.
 */
const SPELLED_COUNTS = {
  'mobile-web-app-page-grant-call-sites.mjs': [
    { precedes: 'grants', counted: sessionGrants.length },
    { precedes: 'audio grants', counted: sessionGrants.filter(isAudio).length },
    { precedes: 'rows pin', counted: PAGE_GRANT_CALL_SITES.length },
    { precedes: 'of the session', counted: pinnedHereForSession.length },
    { precedes: 'have censuses of their own', counted: pinnedElsewhere.length },
    // One more than the row above: C8.1's optional grant is censused elsewhere as well, and the
    // sentence here counts what has a census rather than what the route requires.
    { precedes: 'are not repeated here', counted: censusedElsewhere.length }
  ],
  'mobile-web-app-page-grant-call-sites.test.mjs': [
    // Both the header's "eight grants this file pins" and the title's "eight grants".
    { precedes: 'grants', counted: pinnedHere.length },
    { precedes: 'rows covering', counted: PAGE_GRANT_CALL_SITES.length },
    { precedes: 'audio grants', counted: sessionGrants.filter(isAudio).length },
    { precedes: 'did not', counted: pinnedHere.length },
    { precedes: 'through the session route', counted: pinnedHere.length }
  ]
}

function isAudio(grant) {
  return grant.startsWith('native.audio.')
}

describe('the call-site reader', () => {
  const navigate = PAGE_GRANT_CALL_SITES[0]
  const storage = PAGE_GRANT_CALL_SITES[1]

  it('spells the split off the two tables, in this file and in the one it reads', async () => {
    for (const [name, rows] of Object.entries(SPELLED_COUNTS)) {
      const source = await readFile(join(scriptsDir, name), 'utf8')
      for (const { precedes, spelled, counts } of spelledCountsAgainstTables(source, rows)) {
        expect(spelled, `${name}: ${precedes}`).toEqual(counts)
      }
    }
  })

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
