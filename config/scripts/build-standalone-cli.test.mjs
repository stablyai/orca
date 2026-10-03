import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { t as listTar, x as extractTar } from 'tar'
import {
  DESKTOP_ONLY_HANDLER_MODULES,
  buildStandaloneCli,
  findStandaloneCliBundleViolations
} from './build-standalone-cli.mjs'
import { packageStandaloneCli } from './package-standalone-cli.mjs'
import { HANDLER_GROUPS } from '../../src/cli/handler-group-manifest.ts'
import { COMMAND_SPECS } from '../../src/cli/specs/index.ts'
import { isDesktopOnlyCommand } from '../../src/cli/standalone-cli-mode.ts'

const VERSION = '9.9.9-standalone.test'
const workDirs = []
let built

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}

// Why: plain `node`, no Electron, and an isolated user-data dir so no local runtime answers.
function runCli(file, args, userDataPath) {
  const env = { ...process.env, ORCA_USER_DATA_PATH: userDataPath }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ORCA_CLI_STANDALONE
  delete env.ORCA_PAIRING_CODE
  delete env.ORCA_ENVIRONMENT
  return spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env, timeout: 30_000 })
}

beforeAll(async () => {
  built = await buildStandaloneCli({ outDir: tempDir('orca-cli-standalone-'), version: VERSION })
}, 120_000)

afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('standalone CLI bundle guard', () => {
  it('keeps desktop persistence, SQLite, keychain, and Electron out of the bundle', () => {
    const inputs = Object.keys(built.metafile.inputs)
    expect(findStandaloneCliBundleViolations(built.metafile)).toEqual([])
    expect(inputs.some((input) => input.startsWith('src/main/'))).toBe(false)
  })

  it('reports each forbidden input and import', () => {
    const metafile = {
      inputs: {
        'src/cli/index.ts': {
          imports: [
            { path: 'electron', external: true },
            { path: 'node:sqlite', external: true },
            { path: 'node:fs', external: true },
            { path: 'bufferutil', external: true },
            { path: 'left-pad', external: true }
          ]
        },
        'src/main/persistence/profile-state/profile-state-store.ts': { imports: [] },
        'src/main/sqlite/sync-database.ts': { imports: [] },
        'src/main/codex-accounts/keychain-reader.ts': { imports: [] }
      }
    }

    expect(findStandaloneCliBundleViolations(metafile)).toEqual([
      'SQLite adapter: src/main/sqlite/sync-database.ts',
      'desktop persistence: src/main/persistence/profile-state/profile-state-store.ts',
      'forbidden import electron from src/cli/index.ts',
      'forbidden import node:sqlite from src/cli/index.ts',
      'keychain access: src/main/codex-accounts/keychain-reader.ts',
      'unbundled dependency left-pad from src/cli/index.ts'
    ])
  })

  it('stubs only handler groups whose every command is desktop-only', () => {
    for (const entry of DESKTOP_ONLY_HANDLER_MODULES) {
      const group = HANDLER_GROUPS.find((candidate) => candidate.name === entry.group)
      expect(group?.keys.length).toBeGreaterThan(0)
      for (const key of group?.keys ?? []) {
        expect(isDesktopOnlyCommand(key.split(' '))).toBe(true)
      }
    }
  })

  it('refuses exactly the documented desktop-only commands', () => {
    const refused = COMMAND_SPECS.filter((spec) => isDesktopOnlyCommand(spec.path)).map((spec) =>
      spec.path.join(' ')
    )
    expect(refused.sort()).toEqual([
      'account add',
      'account list',
      'agent hooks off',
      'agent hooks on',
      'agent hooks prepare-codex',
      'agent hooks status',
      'artifacts delete',
      'artifacts list',
      'artifacts share',
      'artifacts unshare',
      'artifacts update',
      'claude-teams',
      'open',
      'profile state exports',
      'profile state rollback',
      'serve'
    ])
  })
})

describe('standalone CLI bundle under plain node', () => {
  it('prints the stamped version', () => {
    const result = runCli(built.outfile, ['--version'], tempDir('orca-cli-data-'))
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${VERSION}\n`)
    expect(result.status).toBe(0)
  })

  it('prints help with the standalone boundary', () => {
    const result = runCli(built.outfile, ['help'], tempDir('orca-cli-data-'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: orca <command> [options]')
    expect(result.stdout).toContain('Standalone CLI:')
  })

  it.each([['open'], ['serve'], ['account', 'list'], ['profile', 'state', 'exports']])(
    'refuses desktop-only `%s` without touching a runtime',
    (...commandPath) => {
      const result = runCli(built.outfile, [...commandPath, '--json'], tempDir('orca-cli-data-'))
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'desktop_only_command',
        message: expect.stringContaining('desktop app or headless server')
      })
    }
  )

  it('refuses claude-teams before spawning claude', () => {
    const result = runCli(built.outfile, ['claude-teams', '--help'], tempDir('orca-cli-data-'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('`orca claude-teams` is not available in the standalone')
  })
})

describe('standalone CLI tarball', () => {
  it('packs an npm-installable package whose launcher runs on plain node', async () => {
    const outputDir = tempDir('orca-cli-tgz-')
    const { archivePath, latestPath } = await packageStandaloneCli({
      bundleDir: join(built.outfile, '..'),
      outputDir
    })
    expect(archivePath).toBe(join(outputDir, `orca-cli-${VERSION}.tgz`))
    expect(latestPath).toBe(join(outputDir, 'orca-cli.tgz'))

    const entries = []
    await listTar({ file: archivePath, onReadEntry: (entry) => entries.push(entry.path) })
    expect(entries.filter((entry) => !entry.endsWith('/')).sort()).toEqual([
      'package/LICENSE',
      'package/bin/orca',
      'package/orca.cjs',
      'package/package.json'
    ])

    const installDir = tempDir('orca-cli-install-')
    await extractTar({ file: archivePath, cwd: installDir, strict: true })
    expect(
      JSON.parse(readFileSync(join(installDir, 'package', 'package.json'), 'utf8'))
    ).toMatchObject({
      name: 'orca-cli',
      version: VERSION,
      bin: { orca: 'bin/orca' },
      engines: { node: '>=22' }
    })
    const launcher = join(installDir, 'package', 'bin', 'orca')
    const version = runCli(launcher, ['--version'], tempDir('orca-cli-data-'))
    expect(version.stdout).toBe(`${VERSION}\n`)
    expect(version.status).toBe(0)
    const refusal = runCli(launcher, ['open'], tempDir('orca-cli-data-'))
    expect(refusal.status).toBe(1)
    expect(refusal.stderr).toContain('`orca open` is not available in the standalone')
  })
})
