import { readFileSync, readdirSync } from 'node:fs'
import { join, matchesGlob, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { electronViteConfig } from '../../electron.vite.config'
import { GUARDED_ENTRY_NAMES } from '../build-plugins/plain-node-entry-guard'

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_ROOT = join(REPO_ROOT, 'src', 'cli')
const packaging = createRequire(import.meta.url)('../electron-builder.config.cjs')

function listCliSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listCliSourceFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

// Why: `import type` is erased by tsc, so it needs no emitted module at runtime.
const VALUE_IMPORT_FROM_MAIN = /(?<!\btype\s)from '(?:\.\.\/)+main\/([^']+)'/g
const DYNAMIC_IMPORT_FROM_MAIN = /import\(\s*['"](?:\.\.\/)+main\/([^'"]+)['"]\s*\)/g

function findMainImports(): { file: string; module: string }[] {
  return listCliSourceFiles(CLI_ROOT).flatMap((file) => {
    const source = readFileSync(file, 'utf-8')
    return [
      ...source.matchAll(VALUE_IMPORT_FROM_MAIN),
      ...source.matchAll(DYNAMIC_IMPORT_FROM_MAIN)
    ].map((match) => ({
      file: file.slice(REPO_ROOT.length + 1),
      module: match[1].replace(/\.js$/, '')
    }))
  })
}

function findElectronViteMainEntries(): Record<string, string> {
  const input = electronViteConfig.main?.build?.rollupOptions?.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected named main-process inputs')
  }
  return input
}

describe('CLI imports of main-process modules', () => {
  // Why: electron-vite cleans out/main and emits only its declared entries, so a
  // `src/main/*` module the CLI imports but the config omits is deleted by the
  // build that runs after `build:cli` — keep source-level feedback ahead of the
  // final-artifact runtime verifier.
  it('has an electron-vite entry for every main module the CLI imports', () => {
    const entries = findElectronViteMainEntries()
    const missing = findMainImports().filter(
      ({ module }) => entries[module] !== join(REPO_ROOT, 'src', 'main', `${module}.ts`)
    )

    expect(missing).toEqual([])
  })

  it('guards every CLI main module against Electron imports', () => {
    const guarded = new Set<string>(GUARDED_ENTRY_NAMES)
    expect(findMainImports().filter(({ module }) => !guarded.has(module))).toEqual([])
  })

  it('unpacks every CLI main entry for plain Node outside Electron', () => {
    const missing = findMainImports().filter(
      ({ module }) =>
        !packaging.asarUnpack.some((pattern: string) =>
          matchesGlob(`out/main/${module}.js`, pattern)
        )
    )
    expect(missing).toEqual([])
  })

  it('finds the imports it is meant to guard', () => {
    // Why: a broken matcher would make the guard above vacuously pass.
    expect(findMainImports()).toContainEqual({
      file: join('src', 'cli', 'profile-state-location.ts'),
      module: 'persistence/profile-state/profile-state-active-location'
    })
    expect(findMainImports()).toContainEqual({
      file: join('src', 'cli', 'handlers', 'agent-hooks.ts'),
      module: 'orca-profiles/profile-index-store'
    })
    expect(findMainImports().length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(findElectronViteMainEntries()).length).toBeGreaterThanOrEqual(2)
  })
})
