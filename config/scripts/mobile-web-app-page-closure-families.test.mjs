/**
 * Each page closure reaches exactly the families its pin tables commit.
 *
 * The pins are the oracle for what each of those goldens does at the bridge, and this is the
 * precondition they cannot state for themselves: that the set of families is still the derived one.
 * A scenario recorded tomorrow at a call site the route already imports arrives in a family nobody
 * pinned, and every assertion in the pin files stays green because each walks the table it has.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  mobileWebAppModuleClosure,
  mobileWebAppRouteClosure
} from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { pageClosureFamilies, pinnedFamilyNames } from './mobile-web-app-page-closure-families.mjs'

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip
const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const C1_TABLE = 'mobile/src/test-support/bridged-parity/c1-page-closure.ts'

/** Per domain: C1's table, which every page closure inherits, and the halves that domain adds.
 *  The composed `cN-page-closure.ts` modules only spread these, so the halves are the evidence. */
const PIN_TABLES = [
  C1_TABLE,
  'mobile/src/test-support/bridged-parity/c2-work-item-closure-families.ts',
  'mobile/src/test-support/bridged-parity/c2-task-source-closure-families.ts'
]
const C6_PIN_TABLE = 'mobile/src/test-support/bridged-parity/c6-browser-closure-families.ts'

const FILES_PIN_TABLES = [
  C1_TABLE,
  'mobile/src/test-support/bridged-parity/c3-explorer-closure-families.ts',
  'mobile/src/test-support/bridged-parity/c3-preview-closure-families.ts'
]

/** Both files routes, because the C3 closure is their union and either alone pins fewer
 *  families. */
const FILES_ROUTES = [
  'app/h/[hostId]/files/[worktreeId].tsx',
  'app/h/[hostId]/files/preview/[worktreeId].tsx'
]

const SITE = 'mobile/src/tasks/MobileTasksScreen.tsx'

describe('the families a page closure reaches', () => {
  it('names a family newly recorded at a site already inside the closure', () => {
    // The case the pin tables are blind to, and the reason this file exists.
    const scenarios = [
      { family: 'tasks.item-detail-github', sites: [SITE] },
      { family: 'tasks.newly-recorded', sites: [SITE] }
    ]
    expect(pageClosureFamilies(['src/tasks/MobileTasksScreen.tsx'], scenarios)).toEqual([
      'tasks.item-detail-github',
      'tasks.newly-recorded'
    ])
  })

  it('ignores a family whose every site is outside the closure', () => {
    const scenarios = [
      { family: 'session.diff-review', sites: ['mobile/src/session/elsewhere.ts'] }
    ]
    expect(pageClosureFamilies(['src/tasks/MobileTasksScreen.tsx'], scenarios)).toEqual([])
  })

  it("drops the shell's own families, which belong to the shell", () => {
    const scenarios = [{ family: 'mobileWeb.bundle-manifest', sites: [SITE] }]
    expect(pageClosureFamilies(['src/tasks/MobileTasksScreen.tsx'], scenarios)).toEqual([])
  })

  it('reads a module outside mobile/ at the path the corpus spells it', () => {
    // The closure reports those as `../src/shared/…`; 88 of the tasks closure's 428 are.
    const scenarios = [{ family: 'shared.thing', sites: ['src/shared/protocol-version.ts'] }]
    expect(pageClosureFamilies(['../src/shared/protocol-version.ts'], scenarios)).toEqual([
      'shared.thing'
    ])
  })

  it('reads the family names out of a pin table, and nothing else in it', () => {
    const names = pinnedFamilyNames(read(PIN_TABLES[0]))
    expect({ families: names.length, first: names[0] }).toEqual({
      families: 22,
      first: 'settings.repo-metadata'
    })
  })
})

/** The families a route's own closure reaches, checked against the tables that pin them. */
async function expectClosureFamilies(localModules, tables) {
  const scenarios = JSON.parse(read('mobile/rpc-foundation/pilot-scenarios.json')).scenarios
  const perTable = tables.map((path) => pinnedFamilyNames(read(path)))
  // That every table was read rather than none, which an empty expectation would satisfy. A lower
  // bound and not the exact count, deliberately: the comparison below is the one to make, and a
  // guard on the number fires first and reports a number where the set reports the family's name.
  expect(perTable.filter((names) => names.length === 0)).toEqual([])
  const pinned = perTable.flat().sort()
  expect(new Set(pinned).size).toBe(pinned.length)
  expect(pageClosureFamilies(localModules, scenarios)).toEqual(pinned)
}

describeClosure('the tasks page closure', () => {
  it('reaches exactly the golden families the pin tables commit', async () => {
    const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
    await expectClosureFamilies(closure.local, PIN_TABLES)
  }, 60_000)
})

describeClosure('the files page closures', () => {
  it('reach exactly the golden families the pin tables commit, as a union', async () => {
    // The union, because C3 is one pin table over two routes: the explorer alone reaches neither
    // preview family, and the preview alone reaches no explorer family, so either route on its own
    // would report a set the table legitimately exceeds.
    const closures = await Promise.all(FILES_ROUTES.map((route) => mobileWebAppRouteClosure(route)))
    const union = [...new Set(closures.flatMap((closure) => closure.local))]
    await expectClosureFamilies(union, FILES_PIN_TABLES)
  }, 120_000)

  it('each reach a strict part of it, which is what makes the union the oracle', async () => {
    // Without this the union above would also pass with one route contributing nothing at all.
    const scenarios = JSON.parse(read('mobile/rpc-foundation/pilot-scenarios.json')).scenarios
    const [explorer, preview] = await Promise.all(
      FILES_ROUTES.map((route) => mobileWebAppRouteClosure(route))
    )
    const explorerFamilies = pageClosureFamilies(explorer.local, scenarios)
    const previewFamilies = pageClosureFamilies(preview.local, scenarios)
    expect(explorerFamilies).toContain('files.explorer-screen')
    expect(explorerFamilies).not.toContain('files.preview-load')
    expect(previewFamilies).toContain('files.preview-load')
    expect(previewFamilies).not.toContain('files.explorer-screen')
  }, 120_000)
})

describeClosure('the browser pane closure', () => {
  /** The pane is mounted by a route, not registered as one, so its closure is read from the module
   *  itself. C7 composes this half with the session route and censuses the route the usual way. */
  const PANE = 'src/browser/MobileBrowserPane'

  it('reaches exactly the golden families its pin table commits, on its own', async () => {
    const closure = await mobileWebAppModuleClosure([PANE])
    await expectClosureFamilies(closure.local, [C6_PIN_TABLE])
  }, 60_000)

  it('adds exactly those families to a page, and no other', async () => {
    // The pin is a half: alone it would also pass if the pane dragged in a family C1 already pins
    // and the table happened to list it. This reads the difference the pane makes to the layout.
    const scenarios = JSON.parse(read('mobile/rpc-foundation/pilot-scenarios.json')).scenarios
    const [layout, withPane] = await Promise.all([
      mobileWebAppModuleClosure(['app/h/_layout']),
      mobileWebAppModuleClosure(['app/h/_layout', PANE])
    ])
    const layoutFamilies = pageClosureFamilies(layout.local, scenarios)
    const added = pageClosureFamilies(withPane.local, scenarios).filter(
      (family) => !layoutFamilies.includes(family)
    )
    expect(added).toEqual(pinnedFamilyNames(read(C6_PIN_TABLE)).sort())
    // And that the layout is the C1 control it is everywhere else, so the difference above is real.
    expect(layoutFamilies).toEqual(pinnedFamilyNames(read(C1_TABLE)).sort())
  }, 120_000)
})
