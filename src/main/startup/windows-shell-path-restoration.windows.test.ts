import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetHydrateShellPathCache, type HydrationResult } from './hydrate-shell-path'
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
})
