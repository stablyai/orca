import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { runProcessSync } from '../../shared/child-process/run-process'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const directories: string[] = []
const bunRuntime = join(REPO_ROOT, 'out/orcad', orcadBunRuntimeFilename(process.platform))

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.skipIf(!existsSync(bunRuntime))(
  'loads a fresh production import graph before requiring native PTY code',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'orcad-load-order-'))
    directories.push(directory)
    const bundle = join(directory, 'orcad.js')
    const builder = pathToFileURL(join(REPO_ROOT, 'config/scripts/orcad-entry-build.mjs')).href
    const built = runProcessSync({
      program: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import { buildOrcadEntry } from ${JSON.stringify(builder)}; await buildOrcadEntry(${JSON.stringify(bundle)})`
      ],
      cwd: REPO_ROOT,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 60_000
    })
    expect(built.code, built.stderr.slice(0, 2_000)).toBe(0)
    expect(existsSync(bundle)).toBe(true)

    const marker = join(directory, 'premature-native-load')
    const nativeDirectory = join(directory, 'node_modules', 'node-pty')
    mkdirSync(nativeDirectory, { recursive: true })
    writeFileSync(
      join(nativeDirectory, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'node-pty');
` + `throw new Error('native PTY required before preflight')`
    )
    const run = (extraArgs: string[] = []) =>
      runProcessSync({
        program: bunRuntime,
        // The application load-check exits after module evaluation, before probes.
        args: [...extraArgs, bundle, '--orcad-smoke-load-check'],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 30_000
      })

    const loaded = run()
    expect(loaded.code, loaded.stderr.slice(0, 2_000)).toBe(0)
    expect(existsSync(marker)).toBe(false)

    // Prove the interception works without relying on minified source echoed in an error.
    const eagerNative = join(directory, 'eager-native.cjs')
    writeFileSync(eagerNative, "require('node-pty')")
    expect(run(['--require', eagerNative]).code).not.toBe(0)
    expect(existsSync(marker)).toBe(true)
  },
  90_000
)
