import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { RELAY_NATIVE_DEPS } from './ssh-relay-deploy'

/**
 * The relay is a bundle deployed to a host that has none of Orca's node_modules.
 * Every native addon it reaches therefore has to be installed by
 * `installNativeDeps`, or the relay silently loses that capability forever.
 *
 * This exists because #15749 moved the Windows process table onto
 * `@vscode/windows-process-tree` without adding it here. The relay tests all
 * passed: they inject a fake module through
 * `__setWindowsProcessTreeLoaderForTests`, so nothing ever exercised the real
 * require that the remote host would fail. Assert against the real graph.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/**
 * Native addons the relay imports but deliberately does NOT install, each with
 * the reason its absence is safe. Adding an entry is a decision, not a default:
 * anything not listed must appear in RELAY_NATIVE_DEPS.
 */
const DEGRADES_WITHOUT_INSTALL: Record<string, string> = {
  '@vscode/windows-process-tree':
    'Windows-only, and both ways of installing it fail. A normal install rebuilds ' +
    'from source because the tarball carries a binding.gyp, and that build fails ' +
    'with MSB8040 (Spectre-mitigated libraries) even on a host that already has ' +
    'MSVC Build Tools — our patch drops that requirement, and pnpm patches do not ' +
    'cross SSH. Skipping the build keeps the tarball binary, which predates the ' +
    'patch and still caps enumeration at 1024 processes, so a busy host gets a ' +
    'truncated table missing its own pid. windows-process-table.ts falls back to a ' +
    'Get-CimInstance scan when the binding is absent. See ' +
    'docs/reference/windows-process-enumeration.md.'
}

/** Addons are the packages npm has to build or unpack a binary for. */
function nativeDependencyNames(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {})
  ])
  return [...declared].filter((name) => {
    const dir = join(REPO_ROOT, 'node_modules', name)
    return existsSync(join(dir, 'binding.gyp')) || existsSync(join(dir, 'prebuilds'))
  })
}

/**
 * Source files reachable from the relay entry.
 *
 * Why the metafile and not the emitted bundle: the process table resolves its
 * addon through `createRequire`, which esbuild cannot see and minification
 * rewrites, so the specifier only survives reliably in the sources.
 */
async function relayReachableSources(): Promise<string[]> {
  const result = await build({
    entryPoints: [join(REPO_ROOT, 'src', 'relay', 'relay.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    write: false,
    metafile: true,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  return Object.keys(result.metafile.inputs).filter((input) => !input.includes('node_modules'))
}

describe('relay native dependency coverage', () => {
  it('installs every native addon the relay bundle imports', async () => {
    const sources = await relayReachableSources()
    const text = sources.map((file) => readFileSync(join(REPO_ROOT, file), 'utf8')).join('\n')

    const imported = nativeDependencyNames().filter(
      (name) => text.includes(`'${name}'`) || text.includes(`"${name}"`)
    )
    expect(imported.length).toBeGreaterThan(0)

    const uncovered = imported.filter(
      (name) => !(name in RELAY_NATIVE_DEPS) && !(name in DEGRADES_WITHOUT_INSTALL)
    )
    expect(uncovered).toEqual([])
  }, 60_000)

  it('keeps every installed native dep at the version the app depends on', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const declared = { ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const [name, version] of Object.entries(RELAY_NATIVE_DEPS)) {
      // The relay pins exact versions where the app carries a range, so compare
      // the base: a relay on a different version than the app marshals the same
      // node-pty/watcher data through a binding nothing else cross-checks.
      expect(declared[name]?.replace(/^[\^~]/, ''), `${name} matches the app`).toBe(version)
    }
  })
})
