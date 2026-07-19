// Why: the standalone `orca` CLI is plain tsc CJS output run under
// ELECTRON_RUN_AS_NODE, and packaged installs ship no `electron` module in
// node_modules (config/packaged-runtime-node-modules.cjs excludes it) — a
// static electron import anywhere in the CLI build graph crashes every `orca`
// command at startup with MODULE_NOT_FOUND. Typecheck cannot catch this
// (electron types are a devDependency), so guard the whole tsconfig.cli.json
// include set. Electron access from modules shared with the CLI must be a
// lazy `require('electron')` in a try/catch with a non-electron fallback
// (see claude-config-dir-hook-controls.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const configDir = resolve(__dirname, '..', '..', 'config')

function readCliTsconfigIncludes(): string[] {
  const raw = readFileSync(join(configDir, 'tsconfig.cli.json'), 'utf-8')
  // The tsconfig carries `//` comment lines; strip them before JSON.parse.
  const withoutComments = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  return (JSON.parse(withoutComments) as { include: string[] }).include
}

function collectTsFiles(path: string, out: string[]): void {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) {
      collectTsFiles(join(path, entry), out)
    }
    return
  }
  // Test files are compiled by the CLI tsconfig but never loaded by the CLI
  // at runtime, so they may reference electron (mocks) without breaking it.
  if (
    path.endsWith('.ts') &&
    !path.endsWith('.d.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.test-fixture.ts')
  ) {
    out.push(path)
  }
}

function hasStaticElectronImport(source: string): boolean {
  for (const match of source.matchAll(/from\s+['"]electron['"]/g)) {
    const importStart = source.lastIndexOf('import', match.index)
    if (importStart === -1) {
      continue
    }
    // Type-only imports are erased at compile time and are safe.
    if (!/^import\s+type[\s{]/.test(source.slice(importStart, match.index))) {
      return true
    }
  }
  return false
}

describe('orca CLI build graph', () => {
  it('contains no static electron imports', () => {
    const files: string[] = []
    for (const include of readCliTsconfigIncludes()) {
      collectTsFiles(resolve(configDir, include.replace(/\/\*\*\/\*$/, '')), files)
    }
    // Sanity: the include expansion actually found the build graph.
    expect(files.length).toBeGreaterThan(50)

    const offenders = files
      .filter((file) => hasStaticElectronImport(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(resolve(configDir, '..').length + 1))
    expect(offenders).toEqual([])
  })
})
