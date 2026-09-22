/* oxlint-disable anti-slop/no-module-mocking -- This IS the Vitest spec for run-headless-serve-shutdown-docker.mjs, but the rule's test-file
   override globs only .ts/.tsx, so a .test.mjs spec slips through. The script under test is a
   top-level CLI module driven via vi.resetModules() + await import(); the only other way to observe
   its docker argv is to spawn real docker. */
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

  it.each(['desktop', 'extraction', 'signal'])(
    'removes containers before shared resources when %s output capture fails',
    async (stage) => {
      const runningContainers = new Set()
      const blockedRemovals = []
      spawnSync.mockImplementation((_, args) => {
        if (args[0] === 'run') {
          const nameIndex = args.indexOf('--name')
          const name = nameIndex === -1 ? 'anonymous' : args[nameIndex + 1]
          runningContainers.add(name)
          const fails =
            (stage === 'desktop' &&
              args.includes('/usr/local/bin/run-appimage-desktop-startup-case')) ||
            (stage === 'extraction' &&
              args.some((arg) => arg.includes('120s /input/orca.AppImage --appimage-extract'))) ||
            (stage === 'signal' && args.at(-1) === 'INT')
          if (fails) {
            return {
              ...succeeded,
              status: null,
              error: Object.assign(new Error('output capture failed'), { code: 'ENOBUFS' })
            }
          }
          runningContainers.delete(name)
        }
        if (args[0] === 'rm' && args.includes('-f')) {
          runningContainers.delete(args.at(-1))
        }
        if (['volume', 'image'].includes(args[0]) && args[1] === 'rm' && runningContainers.size) {
          blockedRemovals.push(args)
          return { ...succeeded, status: 1 }
        }
        return succeeded
      })

      await expect(run('--all-entrypoints')).rejects.toThrow('output capture failed')
      expect([...runningContainers]).toEqual([])
      expect(blockedRemovals).toEqual([])
    }
  )

  it('continues final cleanup when a removal command cannot start', async () => {
    let failedRemoval = false
    spawnSync.mockImplementation((_, args) => {
      if (args[0] === 'rm' && !failedRemoval) {
        failedRemoval = true
        return { ...succeeded, error: new Error('removal spawn failed') }
      }
      return succeeded
    })

    await run('--all-entrypoints')
    const removals = commands().filter((args) => args[0] === 'rm')
    expect(failedRemoval).toBe(true)
    expect(removals).toHaveLength(8)
    expect(
      commands()
        .slice(-2)
        .map((args) => args.slice(0, 2))
    ).toEqual([
      ['volume', 'rm'],
      ['image', 'rm']
    ])
    expect(console.error).toHaveBeenCalledWith('removal spawn failed')
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

  it('rejects ambiguous matrix overrides before invoking Docker', async () => {
    await expect(run('--all-entrypoints', '--entrypoint', 'launcher')).rejects.toThrow(
      'cannot be combined'
    )
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
