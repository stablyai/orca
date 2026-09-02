import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetHydrateShellPathCache,
  configureWindowsShellPathHydration,
  hydrateShellPath,
  mergePathSegments,
  type HydrationResult
} from './hydrate-shell-path'
import { createWindowsShellPathHydration } from './windows-shell-path-hydration'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function successfulHydration(segments: string[]): HydrationResult {
  return { segments, ok: true, failureReason: 'none' }
}

function resolveProbe(pathValue: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathValue, PATHEXT: '.CMD;.EXE' }
  delete env.Path
  const result = spawnSync(
    process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    ['/d', '/s', '/c', 'orca-path-probe.cmd'],
    { encoding: 'utf8', env }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

describe.runIf(process.platform === 'win32')('Windows shell PATH restoration', () => {
  const originalPath = process.env.PATH
  let fixtureRoot = ''
  let shellADir = ''
  let shellBDir = ''
  let shellBProfileDir = ''

  beforeEach(() => {
    _resetHydrateShellPathCache()
    fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-shell-path-'))
    shellADir = join(fixtureRoot, 'shell-a')
    shellBDir = join(fixtureRoot, 'shell-b')
    shellBProfileDir = join(fixtureRoot, 'shell-b-profile')
    mkdirSync(shellADir)
    mkdirSync(shellBDir)
    mkdirSync(shellBProfileDir)
    writeFileSync(join(shellADir, 'orca-path-probe.cmd'), '@echo shell-a\r\n')
    writeFileSync(join(shellBDir, 'orca-path-probe.cmd'), '@echo shell-b\r\n')
  })

  afterEach(() => {
    _resetHydrateShellPathCache()
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    rmSync(fixtureRoot, { force: true, recursive: true })
  })

  it('restores the inherited baseline before applying a different shell profile', () => {
    const baseline = [shellBDir, shellADir]
    process.env.PATH = baseline.join(pathWin32.delimiter)

    mergePathSegments([shellADir, shellBDir])
    expect(process.env.PATH?.split(pathWin32.delimiter)).toEqual([shellADir, shellBDir])
    expect(resolveProbe(process.env.PATH ?? '')).toBe('shell-a')

    configureWindowsShellPathHydration('git-bash', 'C:\\Git\\bin\\bash.exe')
    const shellBOutput = [shellBProfileDir, ...(process.env.PATH ?? '').split(pathWin32.delimiter)]
    mergePathSegments(shellBOutput)

    expect({
      path: process.env.PATH?.split(pathWin32.delimiter),
      selectedExecutable: resolveProbe(process.env.PATH ?? '')
    }).toEqual({
      path: [shellBProfileDir, ...baseline],
      selectedExecutable: 'shell-b'
    })
  })

  it('generation-fences an active shell A probe before shell B inherits the baseline', async () => {
    const baseline = [shellBDir, shellADir]
    process.env.PATH = baseline.join(pathWin32.delimiter)
    const shellAResult = deferred<HydrationResult>()
    const hydrate = vi.fn<() => Promise<HydrationResult>>()
    hydrate
      .mockReturnValueOnce(shellAResult.promise)
      .mockImplementationOnce(async () =>
        successfulHydration([
          shellBProfileDir,
          ...(process.env.PATH ?? '').split(pathWin32.delimiter)
        ])
      )
    const coordinator = createWindowsShellPathHydration({ hydrate })

    const shellAReady = coordinator.hydrate('powershell.exe')
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledOnce())
    const shellBReady = coordinator.hydrate('git-bash')
    shellAResult.resolve(successfulHydration([shellADir, shellBDir]))
    await Promise.all([shellAReady, shellBReady])

    expect(process.env.PATH?.split(pathWin32.delimiter)).toEqual([shellBProfileDir, ...baseline])
    expect(resolveProbe(process.env.PATH ?? '')).toBe('shell-b')
  })

  it('preserves a newly installed PATH entry across shell changes', () => {
    const baseline = [shellBDir, shellADir]
    const installedDir = join(fixtureRoot, 'newly-installed')
    process.env.PATH = baseline.join(pathWin32.delimiter)
    mergePathSegments([shellADir, shellBDir])
    process.env.PATH += `${pathWin32.delimiter}${installedDir}`

    configureWindowsShellPathHydration('git-bash', 'C:\\Git\\bin\\bash.exe')
    mergePathSegments([shellBProfileDir, ...(process.env.PATH ?? '').split(pathWin32.delimiter)])

    expect(process.env.PATH?.split(pathWin32.delimiter)).toEqual([
      shellBProfileDir,
      ...baseline,
      installedDir
    ])
  })

  it.each(['cmd.exe', 'wsl.exe'])('restores the exact baseline before switching to %s', (shell) => {
    const baseline = `${shellBDir};${shellBDir.toUpperCase()}\\;C:\\;\\\\Server\\Share\\`
    process.env.PATH = baseline
    mergePathSegments([shellADir, shellBDir])

    configureWindowsShellPathHydration(shell)

    expect(process.env.PATH).toBe(baseline)
  })

  it('restores the baseline before a forced same-shell probe', async () => {
    const baseline = [shellBDir, shellADir].join(pathWin32.delimiter)
    process.env.PATH = baseline
    mergePathSegments([shellADir, shellBDir])
    let inheritedPath = ''

    await hydrateShellPath({
      force: true,
      spawner: async () => {
        inheritedPath = process.env.PATH ?? ''
        return { segments: [], ok: false, failureReason: 'empty_path' }
      }
    })

    expect(inheritedPath).toBe(baseline)
    expect(process.env.PATH).toBe(baseline)
  })
})
