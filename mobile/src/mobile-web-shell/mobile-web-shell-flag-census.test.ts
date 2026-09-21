import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

/**
 * The hybrid shell flag is the whole of what keeps this feature dark, so who touches it is a
 * product invariant rather than a convention. A second reader is how a dark feature stops being
 * dark: a launch-time sweep, a prefetch or a menu item that consults the flag would run in a store
 * build the moment anything flipped it, and none of those would fail a type check.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')
const FLAG_KEY = 'orca:mobileWebShellEnabled'
const DEFINITION = 'src/storage/preferences.ts'
/** The one product reader. Every route asks it, so the list below stays the whole census. */
const FLAG_HOOK = 'src/mobile-web-shell/use-mobile-web-shell-enabled.ts'
const ROUTE = 'app/h/[hostId]/web.tsx'
const HOST_ROUTE = 'app/h/[hostId]/index.tsx'
const AGENT_HISTORY_ROUTE = 'app/h/[hostId]/agent-history/[worktreeId].tsx'
const TASKS_ROUTE = 'app/h/[hostId]/tasks.tsx'
const FILES_ROUTE = 'app/h/[hostId]/files/[worktreeId].tsx'
const FILES_PREVIEW_ROUTE = 'app/h/[hostId]/files/preview/[worktreeId].tsx'
const SOURCE_CONTROL_ROUTE = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW_ROUTE = 'app/h/[hostId]/review/[worktreeId].tsx'
/** The one switch with no native screen behind it; its route file only re-exports this body. */
const CATCH_ALL_ROUTE = 'src/mobile-web-shell/catch-all-page-route.tsx'
/** One entry per screen the flag can switch to the page, which is what a review reads. */
const SWITCHED_ROUTES = [
  HOST_ROUTE,
  AGENT_HISTORY_ROUTE,
  TASKS_ROUTE,
  FILES_ROUTE,
  FILES_PREVIEW_ROUTE,
  SOURCE_CONTROL_ROUTE,
  REVIEW_ROUTE,
  CATCH_ALL_ROUTE
]
const DEVELOPER_ROW = 'src/diagnostics/mobile-web-shell-dev-row.tsx'
/** Every tree that ships in the app bundle, with the floor each must clear. `modules` is two files,
 *  but it is where the native view lives and so the easiest place for a second reader to hide. */
const TREES = { src: 200, app: 10, modules: 1 }
const SHELL_VIEW = 'modules/orca-mobile-web-shell/src/index.ts'

function sourceFiles(directory: string): string[] {
  return censusSourceFiles(join(MOBILE_ROOT, directory))
    .map((path) => relative(MOBILE_ROOT, path))
    .filter((path) => /\.tsx?$/.test(path) && !path.includes('.test.'))
}

const SOURCES = Object.keys(TREES)
  .flatMap((tree) => sourceFiles(tree))
  .map((path) => ({
    path: path.split('\\').join('/'),
    text: readFileSync(join(MOBILE_ROOT, path), 'utf8')
  }))

function filesContaining(needle: string): string[] {
  return SOURCES.filter((file) => file.text.includes(needle))
    .map((file) => file.path)
    .sort()
}

describe('who touches the hybrid shell flag', () => {
  it('reaches every shipped tree, so the absence assertions below cannot pass vacuously', () => {
    const paths = SOURCES.map((file) => file.path)
    expect(paths).toContain(DEFINITION)
    expect(paths).toContain(FLAG_HOOK)
    expect(paths).toContain(ROUTE)
    for (const route of SWITCHED_ROUTES) {
      expect(paths).toContain(route)
    }
    expect(paths).toContain(DEVELOPER_ROW)
    expect(paths).toContain(SHELL_VIEW)
    const trees = Object.keys(TREES)
    for (const [tree, floor] of Object.entries(TREES)) {
      expect(paths.filter((path) => path.startsWith(`${tree}/`)).length).toBeGreaterThan(floor)
    }
    expect(paths.filter((path) => !trees.some((tree) => path.startsWith(`${tree}/`)))).toEqual([])
  })

  it('keeps the storage key itself in one module', () => {
    expect(filesContaining(FLAG_KEY)).toEqual([DEFINITION])
  })

  it('is read by one hook and by the developer row that writes it, and nowhere else', () => {
    expect(filesContaining('loadMobileWebShellEnabled')).toEqual(
      [DEFINITION, DEVELOPER_ROW, FLAG_HOOK].sort()
    )
  })

  it('reaches the switched routes through that hook and no others', () => {
    // Each switched route is a screen the flag decides the renderer of, and one more is one more
    // place a dark feature could turn itself on. The list grows once per domain series, in the PR
    // that switches the route file to MobileWebShellScreen, and never as a side effect of anything
    // else. A switched route is inert until MOBILE_WEB_PAGE_ROUTES lists it as well, so an entry
    // here can land a PR ahead of that one.
    expect(filesContaining('useMobileWebShellEnabled')).toEqual(
      [FLAG_HOOK, ROUTE, ...SWITCHED_ROUTES].sort()
    )
  })

  it('is written only by the developer row', () => {
    expect(filesContaining('saveMobileWebShellEnabled')).toEqual([DEFINITION, DEVELOPER_ROW].sort())
  })
})
