// Child entries referenced by filename must ship beside orcad.js; bundling alone cannot include them.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { orcadArtifactFilenames } from '../../shared/orcad-artifacts'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const RUNTIME_ENTRY_FILENAME = /[A-Za-z0-9_.-]+-(?:entry|worker)\.c?js/g
// Known gaps must disappear as entries ship or references are removed; additions are not exemptions.
const KNOWN_UNSHIPPED_ENTRIES = new Set(['wsl-transcript-fs-process-entry.js'])
const directory = mkdtempSync(join(tmpdir(), 'orcad-runtime-entries-'))

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

function buildOrcadBundles(): string[] {
  const builder = pathToFileURL(join(REPO_ROOT, 'config/scripts/orcad-entry-build.mjs')).href
  const script = `
    import { build } from 'esbuild'
    import { join } from 'node:path'
    import * as entries from ${JSON.stringify(builder)}
    const out = ${JSON.stringify(directory)}
    await entries.buildOrcadEntry(join(out, 'orcad.js'))
    await Promise.all(Object.values(entries.ORCAD_CHILD_ENTRY_POINTS).map((entry) => build({
      entryPoints: [entry], bundle: true, platform: 'node', target: 'node18', format: 'cjs',
      outfile: join(out, entries.orcadChildOutputFilename(entry)),
      external: entries.ORCAD_EXTERNAL_MODULES, plugins: [entries.externalNativeAddons],
      logLevel: 'error'
    })))`
  const built = runProcessSync({
    program: process.execPath,
    args: ['--input-type=module', '-e', script],
    cwd: REPO_ROOT,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 120_000
  })
  expect(built.code, built.stderr.slice(0, 2_000)).toBe(0)
  return readdirSync(directory).map((file) => readFileSync(join(directory, file), 'utf8'))
}

it('ships every worker and child entry orcad loads at runtime', () => {
  const named = new Set(
    buildOrcadBundles().flatMap((text) => text.match(RUNTIME_ENTRY_FILENAME) ?? [])
  )
  const shipped = new Set(orcadArtifactFilenames('linux-x64-glibc', []))
  const missing = [...named].filter(
    (filename) => !shipped.has(filename) && !KNOWN_UNSHIPPED_ENTRIES.has(filename)
  )
  expect(missing, 'add these to ORCAD_ARTIFACTS and build them in build-orcad.mjs').toEqual([])
  for (const filename of KNOWN_UNSHIPPED_ENTRIES) {
    expect(named.has(filename) && !shipped.has(filename), filename).toBe(true)
  }
})

it('ships every child entry build-orcad.mjs builds', async () => {
  const builder = pathToFileURL(join(REPO_ROOT, 'config/scripts/orcad-entry-build.mjs')).href
  const entries = await import(builder)
  const shipped = new Set(orcadArtifactFilenames('linux-x64-glibc', []))
  const built = Object.values<string>(entries.ORCAD_CHILD_ENTRY_POINTS).map((entry) =>
    entries.orcadChildOutputFilename(entry)
  )
  expect(built).toContain('session-scanner-service-entry.js')
  expect(built.filter((filename) => !shipped.has(filename))).toEqual([])
})
