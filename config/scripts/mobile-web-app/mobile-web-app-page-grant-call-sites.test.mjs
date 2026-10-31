// Each grant row has a named verdict and removal control; eight grants in six rows lack the other grants’ dedicated censuses.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  PAGE_ROUTE_MODULES,
  pageRouteModulesCoverTheManifest
} from './mobile-web-app-page-route-modules.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../mobile-web-page-routes.mjs'
import {
  PAGE_GRANT_CALL_SITES,
  createGrantCallSiteReader,
  grantCallSites,
  grantsMissingForRow,
  grantsNeeded,
  moduleReachesGrantRow
} from './mobile-web-app-page-grant-call-sites.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = '/h/[hostId]/session/[worktreeId]'

// Memoize closures: each of eight repeated walks builds a bundle.
const closures = new Map()
const readGrantModule = createGrantCallSiteReader()

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

  it('reuses parsed references across rows while observing source and row changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-grant-reader-'))
    const file = join(directory, 'route.tsx')
    const readModule = createGrantCallSiteReader()
    const closure = { local: ['route.tsx'] }
    const source = 'export const view = <View />; useRouteHandoff()'
    try {
      await writeFile(file, source)
      expect(grantCallSites(directory, closure, navigate, readModule)).toEqual(['route.tsx'])
      expect(grantCallSites(directory, closure, storage, readModule)).toEqual([])
      expect(readModule(source, 'route.tsx', { ...navigate, callee: 'absent' })).toBe(false)
      await writeFile(file, 'export const view = <View />; // useRouteHandoff()')
      expect(grantCallSites(directory, closure, navigate, readModule)).toEqual([])
      await writeFile(file, "import storage from '@react-native-async-storage/async-storage'")
      expect(grantCallSites(directory, closure, storage, readModule)).toEqual(['route.tsx'])
      expect(grantCallSites(directory, closure, navigate, readModule)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
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
})

describeClosure(
  'what each page route reaches, against what it declared',
  () => {
    it.each(['/h/[hostId]/files/[worktreeId]', '/h/[hostId]/files/preview/[worktreeId]'])(
      'can copy preview source under the opening grants of %s',
      async (pathname) => {
        const route = MOBILE_WEB_PAGE_ROUTES.find((entry) => entry.pathname === pathname)
        expect(route).toBeDefined()
        const preview = await closureOf('/h/[hostId]/files/preview/[worktreeId]')
        const writerRow = PAGE_GRANT_CALL_SITES[3]
        const previewClosure = async () => preview
        expect(
          await grantsMissingForRow(mobileDir, [route], previewClosure, writerRow, readGrantModule)
        ).toEqual([])
        const withoutWriter = {
          ...route,
          grants: route.grants.filter((grant) => grant !== 'native.clipboard.write')
        }
        expect(
          await grantsMissingForRow(
            mobileDir,
            [withoutWriter],
            previewClosure,
            writerRow,
            readGrantModule
          )
        ).toEqual([`${pathname} needs native.clipboard.write`])
      }
    )

    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })

    // One verdict per grant row attributes a missing grant instead of failing a generic whole-manifest check.
    it.each(PAGE_GRANT_CALL_SITES.map((row) => [row.grants.join(' + '), row]))(
      'declares %s on every registered route whose own call sites reach it',
      async (_name, row) => {
        expect(
          await grantsMissingForRow(
            mobileDir,
            MOBILE_WEB_PAGE_ROUTES,
            closureOf,
            row,
            readGrantModule
          )
        ).toEqual([])
      }
    )

    // Derive control entry from reachable seams, not manifest; otherwise any missing grant would redden every row and defeat attribution.
    it.each(PAGE_GRANT_CALL_SITES.map((row) => [row.grants.join(' + '), row]))(
      'reds the session route when it is registered without %s',
      async (_name, row) => {
        const needed = grantsNeeded(mobileDir, await closureOf(SESSION), readGrantModule)
        expect(needed, 'the session route reaches this row').toEqual(
          expect.arrayContaining(row.grants)
        )
        const entry = (grants) => [{ pathname: SESSION, grants }]
        // Positive control: declaring all reachable grants must pass.
        expect(
          await grantsMissingForRow(mobileDir, entry(needed), closureOf, row, readGrantModule)
        ).toEqual([])
        const without = needed.filter((grant) => !row.grants.includes(grant))
        expect(
          await grantsMissingForRow(mobileDir, entry(without), closureOf, row, readGrantModule)
        ).toEqual(row.grants.map((grant) => `${SESSION} needs ${grant}`))
      }
    )

    it('reaches every one of the eight through the session route, and names where', async () => {
      const closure = await closureOf(SESSION)
      // Require nonempty closure so an empty walk cannot pass absence checks.
      expect(closure.local.length).toBeGreaterThan(250)
      expect(grantsNeeded(mobileDir, closure, readGrantModule)).toEqual(
        PAGE_GRANT_CALL_SITES.flatMap((row) => row.grants)
      )
      for (const row of PAGE_GRANT_CALL_SITES) {
        expect(
          grantCallSites(mobileDir, closure, row, readGrantModule).length,
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
        if (grantCallSites(mobileDir, closure, readerRow, readGrantModule).length > 0) {
          reaching.reader.push(pathname)
        }
        if (grantCallSites(mobileDir, closure, mediaRow, readGrantModule).length > 0) {
          reaching.media.push(pathname)
        }
      }
      expect(reaching.reader).toEqual([SESSION])
      expect(reaching.media).toEqual([SESSION])
    })
  },
  240_000
)
