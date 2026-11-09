import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'node:events'

import {
  _resetHydrateShellPathCache,
  configureWindowsShellPathHydration,
  hydrateShellPath,
  mergePathSegments,
  type HydrationResult
} from './hydrate-shell-path'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

type HydrationSpawner = (shell: string) => Promise<HydrationResult>

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

describe('Windows shell PATH hydration', () => {
  const originalPath = process.env.PATH

  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    _resetHydrateShellPathCache()
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  it('serializes shell changes, discards stale results, and caches the newest request', async () => {
    const powerShellResult = deferred<HydrationResult>()
    const gitBashResult = deferred<HydrationResult>()
    let activeProbes = 0
    let maxActiveProbes = 0
    const powerShellSpawner = vi.fn<HydrationSpawner>(async () => {
      activeProbes += 1
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      const result = await powerShellResult.promise
      activeProbes -= 1
      return result
    })
    const gitBashSpawner = vi.fn<HydrationSpawner>(async () => {
      activeProbes += 1
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      const result = await gitBashResult.promise
      activeProbes -= 1
      return result
    })
    process.env.PATH = 'C:\\Windows'
    const powerShellReady = hydrateShellPath({ spawner: powerShellSpawner, force: true })
    const powerShellMerged = powerShellReady.then((result) => mergePathSegments(result.segments))
    await vi.waitFor(() => expect(powerShellSpawner).toHaveBeenCalledWith('powershell.exe'))

    configureWindowsShellPathHydration('git-bash', 'C:\\Git\\bin\\bash.exe')
    const gitBashReady = hydrateShellPath({ spawner: gitBashSpawner, force: true })
    const gitBashMerged = gitBashReady.then((result) => mergePathSegments(result.segments))
    const cachedGitBashReady = hydrateShellPath({ spawner: gitBashSpawner })
    expect(cachedGitBashReady).toBe(gitBashReady)
    expect(gitBashSpawner).not.toHaveBeenCalled()

    powerShellResult.resolve({
      segments: ['C:\\stale-powershell'],
      ok: true,
      failureReason: 'none'
    })
    await vi.waitFor(() => expect(gitBashSpawner).toHaveBeenCalledWith('C:\\Git\\bin\\bash.exe'))
    gitBashResult.resolve({
      segments: ['C:\\current-git-bash'],
      ok: true,
      failureReason: 'none'
    })
    await Promise.all([powerShellMerged, gitBashMerged, cachedGitBashReady])

    expect(maxActiveProbes).toBe(1)
    expect(powerShellSpawner).toHaveBeenCalledOnce()
    expect(gitBashSpawner).toHaveBeenCalledOnce()
    expect(process.env.PATH).toBe('C:\\current-git-bash;C:\\Windows')
  })

  it('discards an active probe when the configured shell has no profile', async () => {
    const powerShellResult = deferred<HydrationResult>()
    const spawner = vi.fn<HydrationSpawner>(() => powerShellResult.promise)
    const staleReady = hydrateShellPath({ spawner, force: true })
    await vi.waitFor(() => expect(spawner).toHaveBeenCalledOnce())

    configureWindowsShellPathHydration('cmd.exe')
    const currentReady = hydrateShellPath({ spawner })
    powerShellResult.resolve({
      segments: ['C:\\stale-powershell'],
      ok: true,
      failureReason: 'none'
    })

    await expect(Promise.all([staleReady, currentReady])).resolves.toEqual([
      { segments: [], ok: false, failureReason: 'no_shell' },
      { segments: [], ok: false, failureReason: 'no_shell' }
    ])
    expect(spawner).toHaveBeenCalledOnce()
  })

  it('removes profile entries when switching to a shell without a profile', () => {
    process.env.PATH = 'C:\\Inherited;C:\\Windows'
    mergePathSegments(['C:\\PowerShell-profile', 'C:\\Inherited'])

    configureWindowsShellPathHydration('cmd.exe')

    expect(process.env.PATH).toBe('C:\\Inherited;C:\\Windows')
  })

  it('replaces profile entries introduced by the previously configured shell', () => {
    process.env.PATH = 'C:\\Inherited;C:\\Windows'
    mergePathSegments(['C:\\PowerShell-profile', 'C:\\Inherited'])

    configureWindowsShellPathHydration('git-bash', 'C:\\Git\\bin\\bash.exe')
    mergePathSegments(['C:\\GitBash-profile', 'C:\\Inherited'])

    expect(process.env.PATH).toBe('C:\\GitBash-profile;C:\\Inherited;C:\\Windows')
  })
})
