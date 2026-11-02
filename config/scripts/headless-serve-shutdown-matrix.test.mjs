import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync }))

let directory
let artifact
let originalArgv
let originalExitCode
const commands = () => spawnSync.mock.calls.map(([, args]) => args)
const signalRuns = () => commands().filter((args) => ['INT', 'TERM'].includes(args.at(-1)))
const succeeded = { status: 0, stdout: '', stderr: '' }

async function run(...options) {
  process.argv = ['node', 'runner', '--appimage', artifact, ...options]
  await import('./run-headless-serve-shutdown-docker.mjs')
}

beforeEach(() => {
  vi.resetModules()
  spawnSync.mockReset().mockReturnValue(succeeded)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  directory = mkdtempSync(join(tmpdir(), 'orca-shutdown-matrix-'))
  artifact = join(directory, 'original.AppImage')
  writeFileSync(artifact, 'original package bytes')
  originalArgv = process.argv
  originalExitCode = process.exitCode
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('packaged shutdown matrix', () => {
  it('shares extraction but isolates every entrypoint and signal', async () => {
    await run('--all-entrypoints')
    expect(commands().filter((args) => args[0] === 'build')).toHaveLength(1)
    const startup = commands().filter((args) =>
      args.includes('/usr/local/bin/run-appimage-desktop-startup-case')
    )
    const extraction = commands().filter((args) =>
      args.some((arg) => arg.includes('120s /input/orca.AppImage --appimage-extract'))
    )
    expect(startup).toHaveLength(1)
    expect(startup[0][startup[0].indexOf('--user') + 1]).toBe('0')
    expect(startup[0][startup[0].indexOf('--cap-add') + 1]).toBe('SYS_ADMIN')
    expect(extraction).toHaveLength(1)
    expect(commands().indexOf(startup[0])).toBeLessThan(commands().indexOf(extraction[0]))
    expect(signalRuns()).toHaveLength(6)
    const names = new Set()
    for (const [index, args] of signalRuns().entries()) {
      const entrypoint = ['app', 'launcher', 'appimage'][Math.floor(index / 2)]
      expect(args).toContain(`ORCA_TEST_ENTRYPOINT=${entrypoint}`)
      expect(args).toContain(
        `ORCA_SIGNAL_TARGET=${entrypoint === 'appimage' ? 'serving-electron' : 'app'}`
      )
      expect(args).toContain(
        `ORCA_INT_DELIVERY=${entrypoint === 'appimage' ? 'pid' : 'foreground-process-group'}`
      )
      expect(args.at(-1)).toBe(index % 2 === 0 ? 'INT' : 'TERM')
      expect(args).toContain(`${artifact}:/input/orca.AppImage:ro`)
      expect(args.some((arg) => arg.endsWith(':/artifacts:ro'))).toBe(true)
      expect(args).toContain('--rm')
      names.add(args[args.indexOf('--name') + 1])
    }
    expect(names.size).toBe(6)
    const evidence = console.log.mock.calls
      .map(([line]) => line)
      .filter((line) => line.startsWith('{'))
      .map(JSON.parse)
    expect(evidence).toHaveLength(3)
    expect(
      evidence.every(
        (entry) =>
          entry.sha256 === createHash('sha256').update('original package bytes').digest('hex')
      )
    ).toBe(true)
    expect(
      commands()
        .slice(-2)
        .map((args) => args.slice(0, 2))
    ).toEqual([
      ['volume', 'rm'],
      ['image', 'rm']
    ])
  })

  it.each(['mount-denied', 'generic-exit', 'app-started', 'extract-assertion-failed'])(
    'bounds desktop extraction fallback: %s',
    async (scenario) => {
      // Mount diagnostics captured in package job123685326492; Docker execution here is mocked.
      const mountFailure = {
        status: 127,
        stdout: 'AppImage desktop launch mode: fuse\n',
        stderr:
          'FAIL: desktop launcher exited before the updater-setup-done marker (status=127)\n' +
          'Cannot mount AppImage, please check your FUSE setup.\n' +
          '/usr/bin/fusermount3: mount failed: Permission denied\n'
      }
      let attempts = 0
      spawnSync.mockImplementation((_, args) => {
        if (!args.includes('/usr/local/bin/run-appimage-desktop-startup-case')) {
          return succeeded
        }
        attempts++
        if (attempts > 1) {
          return scenario === 'extract-assertion-failed'
            ? {
                ...succeeded,
                status: 1,
                stderr: 'FAIL: packaged PTY owning CLI command/profile mismatch'
              }
            : succeeded
        }
        if (scenario === 'generic-exit') {
          return { ...mountFailure, stderr: 'Unexpected crash\n' }
        }
        if (scenario === 'app-started') {
          return { ...mountFailure, stderr: `${mountFailure.stderr}[startup] app-ready t=10\n` }
        }
        return mountFailure
      })
      await (scenario === 'mount-denied'
        ? run('--all-entrypoints')
        : expect(run('--all-entrypoints')).rejects.toThrow(
            `failed with status ${scenario === 'extract-assertion-failed' ? 1 : 127}`
          ))
      const startup = commands().filter((args) =>
        args.includes('/usr/local/bin/run-appimage-desktop-startup-case')
      )
      const retries = scenario === 'mount-denied' || scenario === 'extract-assertion-failed'
      expect(startup).toHaveLength(retries ? 2 : 1)
      expect(startup[0]).not.toContain('ORCA_STARTUP_APPIMAGE_EXTRACT_AND_RUN=1')
      if (retries) {
        expect(startup[1]).toContain('ORCA_STARTUP_APPIMAGE_EXTRACT_AND_RUN=1')
        expect(startup.every((args) => args.includes('--rm'))).toBe(true)
        expect(startup.every((args) => args.includes(`${artifact}:/input/orca.AppImage:ro`))).toBe(
          true
        )
      }
      expect(signalRuns()).toHaveLength(scenario === 'mount-denied' ? 6 : 0)
      expect(commands().at(-2).slice(0, 2)).toEqual(['volume', 'rm'])
    }
  )

  it('attributes failures and still attempts later cases before cleanup', async () => {
    spawnSync.mockImplementation((_, args) =>
      args.at(-1) === 'INT' ? { ...succeeded, status: 7 } : succeeded
    )
    await expect(run('--all-entrypoints')).rejects.toThrow(
      'app:INT:7, launcher:INT:7, appimage:INT:7'
    )
    expect(signalRuns()).toHaveLength(6)
    expect(commands().at(-2).slice(0, 2)).toEqual(['volume', 'rm'])
  })

  it('cleans setup resources without running cases after failed extraction', async () => {
    spawnSync.mockImplementation((_, args) =>
      args.some((arg) => arg.includes('120s /input/orca.AppImage --appimage-extract'))
        ? { ...succeeded, status: 9 }
        : succeeded
    )
    await expect(run('--all-entrypoints')).rejects.toThrow('docker run failed')
    expect(signalRuns()).toHaveLength(0)
    expect(
      commands()
        .slice(-2)
        .map((args) => args.slice(0, 2))
    ).toEqual([
      ['volume', 'rm'],
      ['image', 'rm']
    ])
  })

  it('preserves individual launcher overlay invocations', async () => {
    await run('--entrypoint', 'launcher', '--launcher-exec-overlay')
    expect(signalRuns()).toHaveLength(2)
    expect(signalRuns().every((args) => args.includes('ORCA_TEST_ENTRYPOINT=launcher'))).toBe(true)
    expect(
      commands().some((args) =>
        args.some((arg) => arg.includes("sed -i 's/^ELECTRON_RUN_AS_NODE=1"))
      )
    ).toBe(true)
  })

  it('uses a restored image only as a build cache and still runs every oracle', async () => {
    vi.stubEnv('ORCA_SHUTDOWN_FIXTURE_CACHE_IMAGE', 'sha256:restored-fixture')
    try {
      await run('--all-entrypoints')
      const builds = commands().filter((args) => args[0] === 'build')
      expect(builds).toHaveLength(1)
      expect(builds[0]).toContain('--cache-from')
      expect(builds[0]).toContain('sha256:restored-fixture')
      expect(builds[0]).toContain('--platform')
      expect(builds[0]).toContain('linux/amd64')
      expect(signalRuns()).toHaveLength(6)
      expect(commands().filter((args) => args[0] === 'run')).toHaveLength(8)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects ambiguous matrix overrides before invoking Docker', async () => {
    await expect(run('--all-entrypoints', '--entrypoint', 'launcher')).rejects.toThrow(
      'cannot be combined'
    )
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
