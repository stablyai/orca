import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The hybrid shell flag is the whole of what keeps this feature dark, so who touches it is a
 * product invariant rather than a convention. A second reader is how a dark feature stops being
 * dark: a launch-time sweep, a prefetch or a menu item that consults the flag would run in a store
 * build the moment anything flipped it, and none of those would fail a type check.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')
const FLAG_KEY = 'orca:mobileWebShellEnabled'
const DEFINITION = 'src/storage/preferences.ts'
const ROUTE = 'app/h/[hostId]/web.tsx'
const DEVELOPER_ROW = 'src/diagnostics/mobile-web-shell-dev-row.tsx'
/** Every tree that ships in the app bundle, with the floor each must clear. `modules` is two files,
 *  but it is where the native view lives and so the easiest place for a second reader to hide. */
const TREES = { src: 200, app: 10, modules: 1 }
const SHELL_VIEW = 'modules/orca-mobile-web-shell/src/index.ts'

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(MOBILE_ROOT, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      found.push(path)
    }
  }
  return found
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
    expect(paths).toContain(ROUTE)
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

  it('is read by the route and by the developer row that writes it, and nowhere else', () => {
    expect(filesContaining('loadMobileWebShellEnabled')).toEqual(
      [DEFINITION, DEVELOPER_ROW, ROUTE].sort()
    )
  })

  it('is written only by the developer row', () => {
    expect(filesContaining('saveMobileWebShellEnabled')).toEqual([DEFINITION, DEVELOPER_ROW].sort())
  })
})
