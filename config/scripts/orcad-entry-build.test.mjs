import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  buildOrcadCli,
  buildOrcadEntry,
  escapeLegalCommentTail,
  findNonAsciiSource,
  ORCAD_COMMONJS_MODULE_OPTIONS
} from './orcad-entry-build.mjs'
import { runProcessSync } from '@orca/process-host'

const directory = mkdtempSync(join(tmpdir(), 'orca-structured-provider-build-'))
const bundle = join(directory, 'orcad-server.js')
let serverMetafile

beforeAll(async () => {
  serverMetafile = (await buildOrcadEntry(bundle)).metafile
}, 60_000)

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('ships no runtime Electron imports in the actual server graph', () => {
  const electronImporters = Object.entries(serverMetafile.inputs)
    .filter(([, input]) =>
      input.imports.some(({ path }) => path === 'electron' || path.startsWith('electron/'))
    )
    .map(([path]) => path)
  expect(electronImporters).toEqual([])
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

// #33592: the shipped CLI once bundled jsonc-parser's UMD build, whose relative requires fail.
it('runs a jsonc-parser-backed command from the packaged CLI under plain Node', async () => {
  const cli = join(directory, 'cli', 'index.js')
  await buildOrcadCli(cli)
  const home = join(directory, 'home')
  mkdirSync(home)
  const status = runProcessSync({
    program: process.execPath,
    args: [cli, 'agent', 'hooks', 'status', '--json'],
    cwd: home,
    env: {
      ORCA_BACKGROUND_LAUNCH: '1',
      HOME: home,
      USERPROFILE: home,
      ORCA_USER_DATA_PATH: join(home, 'user-data')
    },
    timeoutMs: 30_000
  })
  expect(status.code, status.stdout + status.stderr).toBe(0)
  expect(JSON.parse(status.stdout).ok).toBe(true)
}, 60_000)

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

it('keeps the server bundle ASCII, so V8 stores its source one byte per character', () => {
  expect(findNonAsciiSource(readFileSync(bundle, 'utf8'))).toBeNull()
})

it('escapes only the trailing license comment, never code', () => {
  const code = 'a=/[\u2726]/;'
  const escaped = escapeLegalCommentTail(
    `${code}\n/*! Bundled license information:\n  (c) Jos\u00e9 \u{1F600}\n*/\n`
  )
  expect(escaped.startsWith(code)).toBe(true)
  expect(escaped).toContain('(c) Jos\\u{e9} \\u{1f600}')
  expect(findNonAsciiSource(escaped.slice(code.length))).toBeNull()
  expect(escapeLegalCommentTail(code)).toBe(code)
})

it('keeps a build with every dark switch turned on ASCII', () => {
  const darkBundle = join(directory, 'orcad-server-dark.js')
  const built = runProcessSync({
    program: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `const { buildOrcadEntry } = await import(${JSON.stringify(
        new URL('./orcad-entry-build.mjs', import.meta.url).href
      )}); await buildOrcadEntry(${JSON.stringify(darkBundle)})`
    ],
    cwd: directory,
    env: { ...process.env, ORCA_LAYOUT_OWNER: 'main', ORCA_SIDEBAR_INPUTS: 'main' },
    timeoutMs: 120_000
  })
  expect(built.code, built.stderr.slice(-2_000)).toBe(0)
  expect(findNonAsciiSource(readFileSync(darkBundle, 'utf8'))).toBeNull()
}, 150_000)
