// Compare route-derived families with golden pin tables; tables alone cannot detect newly reachable, unpinned families.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  mobileWebAppModuleClosure,
  mobileWebAppRouteClosure
} from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { pageClosureFamilies, pinnedFamilyNames } from './mobile-web-app-page-closure-families.mjs'

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip
const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

const C1_TABLE = 'mobile/src/test-support/bridged-parity/c1-page-closure.ts'

// Composed cN tables only spread C1 and domain halves; compare underlying evidence.
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

// C3 pins union of explorer and preview; each alone reaches fewer families.
const FILES_ROUTES = [
  'app/h/[hostId]/files/[worktreeId].tsx',
  'app/h/[hostId]/files/preview/[worktreeId].tsx'
]

const SITE = 'mobile/src/tasks/MobileTasksScreen.tsx'

describe('the families a page closure reaches', () => {
  it('names a family newly recorded at a site already inside the closure', () => {
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
    // External closure paths use ../src/shared/; ensure they still match repo-relative scenario sites.
    const scenarios = [{ family: 'shared.thing', sites: ['src/shared/protocol-version.ts'] }]
    expect(pageClosureFamilies(['../src/shared/protocol-version.ts'], scenarios)).toEqual([
      'shared.thing'
    ])
  })

  it('reads the family names out of a pin table, and nothing else in it', () => {
    const source = [
      'export const table = {',
      "  'settings.example': {",
      "    'nested.distractor': {",
      '    },',
      '  },',
      "  // 'comment.distractor': {",
      "  'tasks.example': {",
      '  },',
      '}'
    ].join('\n')
    expect(pinnedFamilyNames(source)).toEqual(['settings.example', 'tasks.example'])
  })
})

async function expectClosureFamilies(localModules, tables) {
  const scenarios = JSON.parse(read('mobile/rpc-foundation/pilot-scenarios.json')).scenarios
  const perTable = tables.map((path) => pinnedFamilyNames(read(path)))
  // Require nonempty table reads with a lower bound; exact counts obscure named family differences below.
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
    // C3 table covers union: explorer lacks preview families and preview lacks explorer families.
    const closures = await Promise.all(FILES_ROUTES.map((route) => mobileWebAppRouteClosure(route)))
    const union = [...new Set(closures.flatMap((closure) => closure.local))]
    await expectClosureFamilies(union, FILES_PIN_TABLES)
  }, 120_000)

  it('each reach a strict part of it, which is what makes the union the oracle', async () => {
    // Require both routes contribute; union alone can pass with an empty route closure.
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
  // Pane is mounted, not registered as route; C7 composes this half with session route.
  const PANE = 'src/browser/MobileBrowserPane'

  it('reaches exactly the golden families its pin table commits, on its own', async () => {
    const closure = await mobileWebAppModuleClosure([PANE])
    await expectClosureFamilies(closure.local, [C6_PIN_TABLE])
  }, 60_000)

  it('adds exactly those families to the session route, which is the route that mounts it', async () => {
    // C7.7 registered session route reaches surrounding src/session; reading pane module alone misses families shared with its screen.
    const scenarios = JSON.parse(read('mobile/rpc-foundation/pilot-scenarios.json')).scenarios
    const [layout, route] = await Promise.all([
      mobileWebAppModuleClosure(['app/h/_layout']),
      mobileWebAppRouteClosure('app/h/[hostId]/session/[worktreeId].tsx')
    ])
    const layoutFamilies = pageClosureFamilies(layout.local, scenarios)
    const routeFamilies = pageClosureFamilies(route.local, scenarios)
    // Pane families belong to route, not layout; use containment because C7.8 pins broader route set.
    for (const family of pinnedFamilyNames(read(C6_PIN_TABLE))) {
      expect(routeFamilies, family).toContain(family)
      expect(layoutFamilies, family).not.toContain(family)
    }
    // Require C1 layout control or a set containing everything could satisfy containment.
    expect(layoutFamilies).toEqual(pinnedFamilyNames(read(C1_TABLE)).sort())
  }, 300_000)

  it('adds exactly those families to a page, and no other', async () => {
    // Compare pane minus layout; half alone would pass if it redundantly listed a C1 family.
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
    // Require C1 layout control so difference above is meaningful.
    expect(layoutFamilies).toEqual(pinnedFamilyNames(read(C1_TABLE)).sort())
  }, 120_000)
})
