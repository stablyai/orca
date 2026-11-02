import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildOrcadEntry, ORCAD_COMMONJS_MODULE_OPTIONS } from './orcad-entry-build.mjs'
import { runProcessSync } from '@orca/process-host'

const directory = mkdtempSync(join(tmpdir(), 'orca-structured-provider-build-'))
const bundle = join(directory, 'orcad-server.js')

beforeAll(async () => {
  await buildOrcadEntry(bundle)
}, 60_000)

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('loads the structured Claude SDK through the packaged server under plain Node', () => {
  const loaded = runProcessSync({
    program: process.execPath,
    args: [bundle, '--orcad-structured-provider-load-check'],
    cwd: directory,
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(loaded.code, loaded.stderr.slice(-2_000)).toBe(0)
}, 40_000)

it('resolves bundle-relative requires after deployment to a path with URL-special characters', async () => {
  const buildDirectory = join(directory, 'build')
  mkdirSync(buildDirectory)
  const outfile = join(buildDirectory, 'entry.cjs')
  await build({
    ...ORCAD_COMMONJS_MODULE_OPTIONS,
    stdin: {
      contents: `import { createRequire } from 'node:module';
        console.log(createRequire(import.meta.url)('./asset.cjs'));`,
      resolveDir: directory
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    minify: true,
    logLevel: 'error'
  })
  writeFileSync(join(buildDirectory, 'asset.cjs'), 'module.exports = "deployed asset"')
  const deployedDirectory = join(directory, 'deployed # 100%')
  renameSync(buildDirectory, deployedDirectory)
  const loaded = runProcessSync({
    program: process.execPath,
    args: [join(deployedDirectory, 'entry.cjs')],
    cwd: directory,
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(loaded.code, loaded.stderr).toBe(0)
  expect(loaded.stdout.trim()).toBe('deployed asset')
})

it.each(['import.meta', 'import.meta.dirname', 'import.meta.filename', 'import.meta.resolve'])(
  'rejects unsupported %s instead of silently replacing it with an empty object',
  async (expression) => {
    await expect(
      build({
        ...ORCAD_COMMONJS_MODULE_OPTIONS,
        stdin: { contents: `console.log(${expression})`, resolveDir: directory },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        logLevel: 'silent'
      })
    ).rejects.toThrow('"import.meta" is not available')
  }
)
