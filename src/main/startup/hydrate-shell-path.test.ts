import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import {
  _resetHydrateShellPathCache,
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
  const originalHome = process.env.HOME
  const tempDirs: string[] = []

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'orca-hydrate-shell-path-'))
    tempDirs.push(home)
    return home
  }

  beforeEach(() => {
    _resetHydrateShellPathCache()
    spawnMock.mockReset()
    process.env.HOME = createHome()
  })

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
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

  // Why: #5657 hangs when this probe runs interactive rc init. Startup must
  // stay login-non-interactive and rely on no-spawn fallbacks for rc-only dirs.
  it('uses a login-non-interactive shell (-lc, not -ilc) for the PATH probe', async () => {
    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)

    const resultPromise = hydrateShellPath({ shellOverride: '/bin/zsh', force: true })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [spawnedShell, spawnArgs] = spawnMock.mock.calls[0]
    expect(spawnedShell).toBe('/bin/zsh')
    expect(spawnArgs[0]).toBe('-lc')
    expect(spawnArgs).not.toContain('-ilc')

    // The parser still accepts manager dirs when login files provide them.
    const path = [
      '/Users/tester/.cargo/bin',
      '/Users/tester/.pyenv/shims',
      '/Users/tester/.volta/bin',
      '/opt/homebrew/bin'
    ].join(delimiter)
    proc.stdout.emit('data', Buffer.from(`__ORCA_SHELL_PATH__${path}__ORCA_SHELL_PATH__`))
    proc.emit('close')

    const result = await resultPromise
    expect(result).toEqual({
      segments: [
        '/Users/tester/.cargo/bin',
        '/Users/tester/.pyenv/shims',
        '/Users/tester/.volta/bin',
        '/opt/homebrew/bin'
      ],
      ok: true,
      failureReason: 'none'
    })
  })

  it('adds simple rc-only PATH exports statically without restoring interactive shell startup', async () => {
    const home = createHome()
    const guardedBin = join(home, 'company', 'bin')
    mkdirSync(guardedBin, { recursive: true })
    writeFileSync(
      join(home, '.zshrc'),
      ['if [[ -o interactive ]]; then', '  export PATH="$HOME/company/bin:$PATH"', 'fi'].join('\n')
    )
    process.env.HOME = home

    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)

    const resultPromise = hydrateShellPath({ shellOverride: '/bin/zsh', force: true })

    const [, spawnArgs] = spawnMock.mock.calls[0]
    expect(spawnArgs[0]).toBe('-lc')

    proc.stdout.emit('data', Buffer.from('__ORCA_SHELL_PATH__/usr/bin__ORCA_SHELL_PATH__'))
    proc.emit('close')

    await expect(resultPromise).resolves.toEqual({
      segments: [guardedBin, '/usr/bin'],
      ok: true,
      failureReason: 'none'
    })
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

      await vi.advanceTimersByTimeAsync(5000)

      await assertion
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
      expect(proc.stdout.listenerCount('data')).toBe(0)
      expect(proc.listenerCount('error')).toBe(0)
      expect(proc.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses static rc PATH exports when the shell probe times out', async () => {
    vi.useFakeTimers()
    const home = createHome()
    const guardedBin = join(home, 'timeout-company', 'bin')
    mkdirSync(guardedBin, { recursive: true })
    writeFileSync(join(home, '.zshrc'), 'export PATH="$HOME/timeout-company/bin:$PATH"\n')
    process.env.HOME = home
    process.env.PATH = '/usr/bin'
    const proc = createMockShellProcess()
    spawnMock.mockReturnValue(proc)

    try {
      const resultPromise = hydrateShellPath({ shellOverride: '/bin/zsh', force: true })
      const assertion = expect(resultPromise).resolves.toEqual({
        segments: [guardedBin, '/usr/bin'],
        ok: true,
        failureReason: 'none'
      })

      await vi.advanceTimersByTimeAsync(5000)

      await assertion
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mergePathSegments', () => {
  const originalPath = process.env.PATH

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
})
