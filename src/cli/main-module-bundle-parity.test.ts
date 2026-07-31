import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_ROOT = join(REPO_ROOT, 'src', 'cli')

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
const VALUE_IMPORT_FROM_MAIN = /(?<!\btype\s)from '\.\.\/\.\.\/main\/([^']+)'/g

function findMainImports(): { file: string; module: string }[] {
  return listCliSourceFiles(CLI_ROOT).flatMap((file) => {
    const source = readFileSync(file, 'utf-8')
    return [...source.matchAll(VALUE_IMPORT_FROM_MAIN)].map((match) => ({
      file: file.slice(REPO_ROOT.length + 1),
      module: match[1]
    }))
  })
}

function findElectronViteMainEntries(): Set<string> {
  const config = readFileSync(join(REPO_ROOT, 'electron.vite.config.ts'), 'utf-8')
  return new Set(
    // Why: entries wrap across lines once the path is long, so allow whitespace.
    [...config.matchAll(/resolve\(\s*'src\/main\/([^']+)\.ts'\s*\)/g)].map((match) => match[1])
  )
}

describe('CLI imports of main-process modules', () => {
  // Why: electron-vite cleans out/main and emits only its declared entries, so a
  // `src/main/*` module the CLI imports but the config omits is deleted by the
  // build that runs after `build:cli` — keep source-level feedback ahead of the
  // final-artifact runtime verifier.
  it('has an electron-vite entry for every main module the CLI imports', () => {
    const entries = findElectronViteMainEntries()
    const missing = findMainImports().filter(({ module }) => !entries.has(module))

    expect(missing).toEqual([])
  })

  it('finds the imports it is meant to guard', () => {
    // Why: a broken matcher would make the guard above vacuously pass.
    expect(findMainImports().length).toBeGreaterThanOrEqual(2)
    expect(findElectronViteMainEntries().size).toBeGreaterThanOrEqual(2)
  })
})
