import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { delimiter } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  _resetHydrateShellPathCache,
  hydrateShellPath,
  isVersionManagerInstallPath,
  mergePathSegments,
  _setLaunchPathForTests,
  type HydrationResult
} from './hydrate-shell-path'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

type HydrationSpawner = (shell: string) => Promise<HydrationResult>

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

describe('hydrateShellPath', () => {
  const originalPath = process.env.PATH

  beforeEach(() => {
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

  it('invokes the provided shell with a custom spawner and returns its segments', async () => {
    let capturedShell = ''
    const result = await hydrateShellPath({
      shellOverride: '/bin/zsh',
      spawner: async (shell) => {
        capturedShell = shell
        return {
          segments: ['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'],
          ok: true,
          failureReason: 'none'
        }
      }
    })

    expect(capturedShell).toBe('/bin/zsh')
    expect(result.ok).toBe(true)
    expect(result.segments).toEqual(['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'])
    expect(result.failureReason).toBe('none')
  })

  it('caches the hydration result so repeated calls do not re-spawn', async () => {
    let spawnCount = 0
    const spawner: HydrationSpawner = async () => {
      spawnCount += 1
      return { segments: ['/a'], ok: true, failureReason: 'none' }
    }

    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })
    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })
    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })

    expect(spawnCount).toBe(1)
  })

  it('re-spawns when force:true is passed — matches the Refresh button contract', async () => {
    let spawnCount = 0
    const spawner: HydrationSpawner = async () => {
      spawnCount += 1
      return { segments: ['/a'], ok: true, failureReason: 'none' }
    }

    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })
    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner, force: true })

    expect(spawnCount).toBe(2)
  })

  it('continues the probe queue after a rejected hydration', async () => {
    const rejectedSpawner = vi.fn<HydrationSpawner>(async () => {
      throw new Error('profile failed')
    })
    const successfulSpawner = vi.fn<HydrationSpawner>(async () => ({
      segments: ['/current'],
      ok: true,
      failureReason: 'none'
    }))

    await expect(
      hydrateShellPath({ shellOverride: '/bin/zsh', spawner: rejectedSpawner, force: true })
    ).rejects.toThrow('profile failed')
    await expect(
      hydrateShellPath({ shellOverride: '/bin/bash', spawner: successfulSpawner, force: true })
    ).resolves.toEqual({ segments: ['/current'], ok: true, failureReason: 'none' })

    expect(successfulSpawner).toHaveBeenCalledWith('/bin/bash')
  })

  it('re-probes after a rejected hydration instead of serving the cached rejection', async () => {
    const spawner = vi.fn<HydrationSpawner>()
    spawner
      .mockRejectedValueOnce(new Error('profile failed'))
      .mockResolvedValueOnce({ segments: ['/retried'], ok: true, failureReason: 'none' })

    await expect(hydrateShellPath({ shellOverride: '/bin/zsh', spawner })).rejects.toThrow(
      'profile failed'
    )
    await expect(hydrateShellPath({ shellOverride: '/bin/zsh', spawner })).resolves.toEqual({
      segments: ['/retried'],
      ok: true,
      failureReason: 'none'
    })
    expect(spawner).toHaveBeenCalledTimes(2)
  })

  it('reports spawn_error instead of rejecting when spawn throws synchronously', async () => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    })

    await expect(hydrateShellPath({ shellOverride: '/bin/zsh', force: true })).resolves.toEqual({
      segments: [],
      ok: false,
      failureReason: 'spawn_error'
    })
  })

  it('returns failureReason:no_shell when no shell is available (Windows path)', async () => {
    const result = await hydrateShellPath({
      shellOverride: null,
      spawner: async () => {
        throw new Error('spawner must not run when shell is null')
      }
    })

    expect(result).toEqual({ segments: [], ok: false, failureReason: 'no_shell' })
  })

  // Why: each failure mode tagged independently so dashboards can pick the
  // right fix (lengthen timeout vs investigate shell-invocation strategy vs
  // surface a UX error). Spawner override stands in for the four resolve
  // sites — the actual classification happens inside `spawnShellAndReadPath`,
  // covered by the existing real-shell smoke surface.
  it('propagates failureReason:timeout from the spawner', async () => {
    const result = await hydrateShellPath({
      shellOverride: '/bin/zsh',
      spawner: async () => ({ segments: [], ok: false, failureReason: 'timeout' })
    })
    expect(result).toEqual({ segments: [], ok: false, failureReason: 'timeout' })
  })

  it('propagates failureReason:spawn_error from the spawner', async () => {
    const result = await hydrateShellPath({
      shellOverride: '/bin/zsh',
      spawner: async () => ({ segments: [], ok: false, failureReason: 'spawn_error' })
    })
    expect(result).toEqual({ segments: [], ok: false, failureReason: 'spawn_error' })
  })

  it('propagates failureReason:empty_path from the spawner', async () => {
    const result = await hydrateShellPath({
      shellOverride: '/bin/zsh',
      spawner: async () => ({ segments: [], ok: false, failureReason: 'empty_path' })
    })
    expect(result).toEqual({ segments: [], ok: false, failureReason: 'empty_path' })
  })

  it('cleans up shell listeners when hydration times out', async () => {
    vi.useFakeTimers()
    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)

    try {
      const resultPromise = hydrateShellPath({ shellOverride: '/bin/zsh', force: true })
      const assertion = expect(resultPromise).resolves.toEqual({
        segments: [],
        ok: false,
        failureReason: 'timeout'
      })

      await vi.advanceTimersByTimeAsync(10_000)

      await assertion
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
      expect(proc.stdout.listenerCount('data')).toBe(0)
      expect(proc.listenerCount('error')).toBe(0)
      expect(proc.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  async function captureProbeEnv(shell = '/bin/bash'): Promise<NodeJS.ProcessEnv> {
    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)
    const resultPromise = hydrateShellPath({ shellOverride: shell, force: true })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    proc.emit('close', 0)
    await resultPromise
    return spawnMock.mock.calls[0][2].env
  }

  it('probes with the launch PATH so seeded fallbacks cannot pin nvm', async () => {
    process.env.PATH = `/home/u/.nvm/versions/node/v26.7.0/bin${delimiter}/usr/bin`
    _setLaunchPathForTests('/usr/bin')

    expect((await captureProbeEnv()).PATH).toBe('/usr/bin')
  })

  it('uses the PATH captured at module load, not a later mutation of process.env', async () => {
    // Why: this is the anti-regression guard. patchPackagedProcessPath mutates
    // process.env.PATH after this module is evaluated; the probe must not see it.
    const seeded = `/seeded/newest-nvm/bin${delimiter}/usr/bin`
    process.env.PATH = seeded

    expect((await captureProbeEnv()).PATH).not.toBe(seeded)
  })

  it('sets a probe marker so rc files can take a fast path', async () => {
    expect((await captureProbeEnv()).ORCA_SHELL_PATH_PROBE).toBe('1')
  })

  // Why: on Windows the probe is PowerShell or Git Bash, so these argv are never produced.
  it.skipIf(process.platform === 'win32').each(['/bin/bash', '/bin/zsh'])(
    'keeps the POSIX login probe for %s',
    async (shell) => {
      await captureProbeEnv(shell)

      expect(spawnMock.mock.calls[0][1]).toEqual([
        '-ilc',
        `printf '%s' '__ORCA_SHELL_PATH__'; printf '%s' "$PATH"; printf '%s' '__ORCA_SHELL_PATH__'`
      ])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reads Nushell PATH while preserving interactive login configuration',
    async () => {
      const proc = createMockShellProcess()
      spawnMock.mockReturnValue(proc)
      const resultPromise = hydrateShellPath({
        shellOverride: '/run/current-system/sw/bin/nu',
        force: true
      })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())

      expect(spawnMock.mock.calls[0][1]).toEqual([
        '-ilc',
        [
          "print -n '__ORCA_SHELL_PATH__';",
          'print -n ($env.PATH | str join (char esep));',
          "print -n '__ORCA_SHELL_PATH__'"
        ].join(' ')
      ])
      proc.stdout.emit(
        'data',
        Buffer.from('__ORCA_SHELL_PATH__/etc/profiles/per-user/me/bin:/usr/bin__ORCA_SHELL_PATH__')
      )
      proc.emit('close', 0)

      await expect(resultPromise).resolves.toEqual({
        segments: ['/etc/profiles/per-user/me/bin', '/usr/bin'],
        ok: true,
        failureReason: 'none'
      })
    }
  )

  it('overwrites the captured key in place so Windows never carries both Path and PATH', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const originalWindowsPath = process.env.Path
    delete process.env.PATH
    process.env.PATH = 'C:\\Users\\u\\.nvm\\versions\\node\\v22.9.0\\bin;C:\\Windows'
    process.env.Path = 'C:\\Users\\u\\.nvm\\versions\\node\\v22.9.0\\bin;C:\\Windows'
    _setLaunchPathForTests('C:\\Windows', 'Path')

    try {
      const env = await captureProbeEnv('C:/Git/bin/bash.exe')
      expect(env.Path).toBe('C:\\Windows')
      expect(env.PATH).toBeUndefined()
    } finally {
      if (originalWindowsPath === undefined) {
        delete process.env.Path
      } else {
        process.env.Path = originalWindowsPath
      }
    }
  })
})

describe('mergePathSegments', () => {
  const originalPath = process.env.PATH

  beforeEach(() => {
    _resetHydrateShellPathCache()
  })

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  // Why: mergePathSegments joins with the platform PATH delimiter, so the
  // expectations must too — hardcoding ':' made this suite fail on Windows
  // dev machines even though the code under test was correct.
  const joinPath = (...segments: string[]): string => segments.join(delimiter)

  it('prepends new segments ahead of existing PATH entries', () => {
    process.env.PATH = joinPath('/usr/bin', '/bin')

    const added = mergePathSegments(['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'])

    expect(added).toEqual(['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'])
    expect(process.env.PATH).toBe(
      joinPath('/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin', '/usr/bin', '/bin')
    )
  })

  it('promotes shell segments already on PATH so shell ordering wins', () => {
    process.env.PATH = joinPath('/Users/tester/.cargo/bin', '/usr/bin')

    const added = mergePathSegments(['/Users/tester/.cargo/bin', '/Users/tester/.opencode/bin'])

    expect(added).toEqual(['/Users/tester/.opencode/bin'])
    expect(process.env.PATH).toBe(
      joinPath('/Users/tester/.cargo/bin', '/Users/tester/.opencode/bin', '/usr/bin')
    )
  })

  it('moves user-local shell paths ahead of packaged Homebrew fallbacks', () => {
    process.env.PATH = joinPath('/opt/homebrew/bin', '/Users/tester/.local/bin', '/usr/bin', '/bin')

    const added = mergePathSegments(['/Users/tester/.local/bin', '/opt/homebrew/bin'])

    expect(added).toEqual([])
    expect(process.env.PATH).toBe(
      joinPath('/Users/tester/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin')
    )
  })

  it('returns [] and leaves PATH untouched when given nothing', () => {
    process.env.PATH = joinPath('/usr/bin', '/bin')

    expect(mergePathSegments([])).toEqual([])
    expect(process.env.PATH).toBe(joinPath('/usr/bin', '/bin'))
  })

  // Why: after mise switches Node (or auto-update inherits the pre-switch env),
  // process PATH still holds the old installs/.../bin while the login shell
  // only exports the current pin. Union merge must drop the stale segment.
  it('drops stale mise install bins that the login shell no longer exports', () => {
    const staleMise = '/Users/tester/.local/share/mise/installs/node/26.5.0/bin'
    const currentMise = '/Users/tester/.local/share/mise/installs/node/24.18.0/bin'
    process.env.PATH = joinPath(staleMise, '/usr/bin', '/bin')

    const added = mergePathSegments([currentMise, '/usr/bin', '/bin'])

    expect(added).toEqual([currentMise])
    expect(process.env.PATH).toBe(joinPath(currentMise, '/usr/bin', '/bin'))
    expect(process.env.PATH).not.toContain('26.5.0')
  })

  it('keeps shell-exported mise install paths at shell order', () => {
    const shellMise = '/Users/tester/.local/share/mise/installs/node/24.18.0/bin'
    process.env.PATH = joinPath('/usr/bin', shellMise, '/bin')

    const added = mergePathSegments([shellMise, '/usr/bin', '/bin'])

    expect(added).toEqual([])
    expect(process.env.PATH).toBe(joinPath(shellMise, '/usr/bin', '/bin'))
  })

  it('preserves non-version-manager process PATH entries missing from shell', () => {
    const customBin = '/Users/tester/.custom-tools/bin'
    const shellMise = '/Users/tester/.local/share/mise/installs/node/24.18.0/bin'
    process.env.PATH = joinPath(customBin, '/usr/bin', '/bin')

    const added = mergePathSegments([shellMise, '/usr/bin', '/bin'])

    expect(added).toEqual([shellMise])
    expect(process.env.PATH).toBe(joinPath(shellMise, '/usr/bin', '/bin', customBin))
  })

  it.each([
    {
      name: 'nvm',
      stale: '/Users/tester/.nvm/versions/node/v20.0.0/bin',
      current: '/Users/tester/.nvm/versions/node/v22.0.0/bin'
    },
    {
      name: 'asdf',
      stale: '/Users/tester/.asdf/installs/nodejs/20.0.0/bin',
      current: '/Users/tester/.asdf/installs/nodejs/22.0.0/bin'
    },
    {
      name: 'fnm multishell (unix bin)',
      stale: '/tmp/fnm_multishells/12345_174350780/bin',
      current: '/tmp/fnm_multishells/99999_174350999/bin'
    },
    {
      // Why: Windows fnm puts the session root on PATH (no trailing /bin). Avoid
      // drive-letter paths here — `C:` collides with the Unix PATH delimiter in tests.
      name: 'fnm multishell (session root)',
      stale: '/Users/tester/AppData/Local/fnm_multishells/12345_174350780',
      current: '/Users/tester/AppData/Local/fnm_multishells/99999_174350999'
    }
  ])('drops stale $name install paths the shell no longer exports', ({ stale, current }) => {
    process.env.PATH = joinPath(stale, '/usr/bin', '/bin')

    const added = mergePathSegments([current, '/usr/bin', '/bin'])

    expect(added).toEqual([current])
    expect(process.env.PATH).toBe(joinPath(current, '/usr/bin', '/bin'))
    expect(process.env.PATH?.includes(stale)).toBe(false)
  })

  it('matches Windows-backslash fnm session roots as install paths', () => {
    expect(
      isVersionManagerInstallPath(
        'C:\\Users\\tester\\AppData\\Local\\fnm_multishells\\12345_174350780'
      )
    ).toBe(true)
  })

  it('does not treat arbitrary paths containing fnm_multishells as install bins', () => {
    const custom = '/opt/myapp/fnm_multishells/tools'
    expect(isVersionManagerInstallPath(custom)).toBe(false)

    process.env.PATH = joinPath(custom, '/usr/bin')
    mergePathSegments(['/usr/bin', '/bin'])
    expect(process.env.PATH).toBe(joinPath('/usr/bin', '/bin', custom))
  })
})
