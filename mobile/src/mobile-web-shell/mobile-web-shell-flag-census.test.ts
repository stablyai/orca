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

const SOURCES = [...sourceFiles('src'), ...sourceFiles('app')].map((path) => ({
  path: path.split('\\').join('/'),
  text: readFileSync(join(MOBILE_ROOT, path), 'utf8')
}))

function filesContaining(needle: string): string[] {
  return SOURCES.filter((file) => file.text.includes(needle))
    .map((file) => file.path)
    .sort()
}

describe('who touches the hybrid shell flag', () => {
  it('reaches both trees, so the absence assertions below cannot pass vacuously', () => {
    const paths = SOURCES.map((file) => file.path)
    expect(paths).toContain(DEFINITION)
    expect(paths).toContain(ROUTE)
    expect(paths).toContain(DEVELOPER_ROW)
    expect(paths.filter((path) => path.startsWith('src/'))).toHaveLength(
      paths.length - paths.filter((path) => path.startsWith('app/')).length
    )
    expect(paths.filter((path) => path.startsWith('src/')).length).toBeGreaterThan(200)
    expect(paths.filter((path) => path.startsWith('app/')).length).toBeGreaterThan(10)
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
