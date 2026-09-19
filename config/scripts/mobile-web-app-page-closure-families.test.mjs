/**
 * The tasks page closure reaches exactly the families the C1 and C2 pin tables commit.
 *
 * The pins are the oracle for what each of those goldens does at the bridge, and this is the
 * precondition they cannot state for themselves: that the set of families is still the derived one.
 * A scenario recorded tomorrow at a call site the route already imports arrives in a family nobody
 * pinned, and every assertion in the pin files stays green because each walks the table it has.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { pageClosureFamilies, pinnedFamilyNames } from './mobile-web-app-page-closure-families.mjs'

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip
const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

/** C1's table and the two halves C2 splits its own across; the composed module only spreads them. */
const PIN_TABLES = [
  'mobile/src/test-support/bridged-parity/c1-page-closure.ts',
  'mobile/src/test-support/bridged-parity/c2-work-item-closure-families.ts',
  'mobile/src/test-support/bridged-parity/c2-task-source-closure-families.ts'
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

describeClosure('the tasks page closure', () => {
  it('reaches exactly the golden families the pin tables commit', async () => {
    const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
    const scenarios = JSON.parse(read('mobile/rpc-foundation/pilot-scenarios.json')).scenarios
    const perTable = PIN_TABLES.map((path) => pinnedFamilyNames(read(path)))
    // That every table was read rather than none, which an empty expectation would satisfy. A
    // lower bound and not the exact 70, deliberately: the count below is the comparison's to make,
    // and a guard on it fires first and reports a number where the set reports the family's name.
    expect(perTable.filter((names) => names.length === 0)).toEqual([])
    const pinned = perTable.flat().sort()
    expect(new Set(pinned).size).toBe(pinned.length)
    expect(pageClosureFamilies(closure.local, scenarios)).toEqual(pinned)
  }, 60_000)
})
