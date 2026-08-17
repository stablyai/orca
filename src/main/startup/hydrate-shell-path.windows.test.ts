import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
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

function createMockShellProcess(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(proc, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: new EventEmitter(),
    kill: vi.fn()
  })
  return proc
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

  it('hydrates the default PowerShell profile PATH on Windows (#13328)', async () => {
    const spawner = vi.fn<HydrationSpawner>(async () => ({
      segments: ['C:\\Users\\tester\\AppData\\Local\\fnm'],
      ok: true,
      failureReason: 'none'
    }))

    await expect(hydrateShellPath({ spawner })).resolves.toEqual({
      segments: ['C:\\Users\\tester\\AppData\\Local\\fnm'],
      ok: true,
      failureReason: 'none'
    })
    expect(spawner).toHaveBeenCalledWith('powershell.exe')
  })

  it('uses the configured PowerShell executable', async () => {
    const spawner = vi.fn<HydrationSpawner>(async () => ({
      segments: ['C:\\tools'],
      ok: true,
      failureReason: 'none'
    }))

    configureWindowsShellPathHydration('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    await hydrateShellPath({ spawner })

    expect(spawner).toHaveBeenCalledWith('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('falls back to Windows PowerShell when preferred pwsh cannot spawn', async () => {
    const spawner = vi.fn<HydrationSpawner>()
    spawner
      .mockResolvedValueOnce({ segments: [], ok: false, failureReason: 'spawn_error' })
      .mockResolvedValueOnce({
        segments: ['C:\\WindowsPowerShell-profile'],
        ok: true,
        failureReason: 'none'
      })
    configureWindowsShellPathHydration('pwsh.exe', null, 'powershell.exe')

    await expect(hydrateShellPath({ spawner })).resolves.toEqual({
      segments: ['C:\\WindowsPowerShell-profile'],
      ok: true,
      failureReason: 'none'
    })
    expect(spawner.mock.calls).toEqual([['pwsh.exe'], ['powershell.exe']])
  })

  it('uses the resolved Git Bash executable for the configured sentinel', async () => {
    const spawner = vi.fn<HydrationSpawner>(async () => ({
      segments: ['C:\\tools'],
      ok: true,
      failureReason: 'none'
    }))

    configureWindowsShellPathHydration('git-bash', 'C:\\Program Files\\Git\\bin\\bash.exe')
    await hydrateShellPath({ spawner })

    expect(spawner).toHaveBeenCalledWith('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('loads PowerShell profiles and parses their Windows PATH', async () => {
    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)
    const resultPromise = hydrateShellPath({ force: true })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

    proc.stdout.emit(
      'data',
      Buffer.from(
        'profile banner\r\n__ORCA_SHELL_PATH__C:\\profile-node;C:\\Windows__ORCA_SHELL_PATH__'
      )
    )
    proc.emit('close', 0, null)

    await expect(resultPromise).resolves.toEqual({
      segments: ['C:\\profile-node', 'C:\\Windows'],
      ok: true,
      failureReason: 'none'
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoLogo', '-Command', expect.stringContaining('$env:Path')],
      expect.objectContaining({ windowsHide: true })
    )
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('-NoProfile')
  })

  it('converts a Git Bash PATH to Windows segments before parsing it', async () => {
    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)
    const resultPromise = hydrateShellPath({
      shellOverride: 'C:\\Program Files\\Git\\bin\\bash.exe',
      force: true
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

    proc.stdout.emit(
      'data',
      Buffer.from('__ORCA_SHELL_PATH__C:\\git-node;C:\\Windows__ORCA_SHELL_PATH__')
    )
    proc.emit('close', 0, null)

    await expect(resultPromise).resolves.toEqual({
      segments: ['C:\\git-node', 'C:\\Windows'],
      ok: true,
      failureReason: 'none'
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      ['-ilc', expect.stringContaining('cygpath -wp "$PATH"')],
      expect.objectContaining({ windowsHide: true })
    )
  })

  it.each(['cmd.exe', 'wsl.exe', 'git-bash', 'C:\\Tools\\zsh.exe'])(
    'does not merge %s guest or profile-less paths',
    async (shell) => {
      const spawner = vi.fn<HydrationSpawner>()

      configureWindowsShellPathHydration(shell)

      await expect(hydrateShellPath({ spawner })).resolves.toEqual({
        segments: [],
        ok: false,
        failureReason: 'no_shell'
      })
      expect(spawner).not.toHaveBeenCalled()
    }
  )

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

  it('deduplicates PATH entries case-insensitively', () => {
    process.env.PATH = 'C:\\Tools;C:\\Windows'

    expect(mergePathSegments(['c:\\tools', 'C:\\profile-node'])).toEqual(['C:\\profile-node'])
    expect(process.env.PATH).toBe('c:\\tools;C:\\profile-node;C:\\Windows')
  })

  it('deduplicates PATH entries with trailing slashes', () => {
    process.env.PATH = 'C:\\Windows\\;C:\\Tools'

    expect(mergePathSegments(['C:\\Windows', 'C:\\profile-node\\'])).toEqual(['C:\\profile-node\\'])
    expect(process.env.PATH).toBe('C:\\Windows;C:\\profile-node\\;C:\\Tools')
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
