import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

function exited(stdout: string, code: number | null = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

const FAILED = exited('', 1)

import {
  _resetWslCachesForTests,
  listRunningWslDistrosAsync,
  listRunningWslHomeDirsAsync
} from './wsl'
import { filterPathsToRunningWslDistrosAsync } from './wsl-running-path-filter'
import { resetWslInteropSpawnDirectoryCache } from './wsl-interop-spawn-directory'
import {
  observeWslTranscriptRunningState,
  resetWslTranscriptRunningObserverForTests
} from './native-chat/wsl-transcript-running-observer'

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('running WSL distro discovery', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    _resetWslCachesForTests()
    resetWslTranscriptRunningObserverForTests()
    vi.useRealTimers()
  })

  it('lists only running user distros without starting them', async () => {
    runProcessMock.mockResolvedValue(exited('Ubuntu\u0000\nDocker-Desktop\u0000\n'))

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          program: 'wsl.exe',
          args: ['--list', '--running', '--quiet'],
          env: expect.objectContaining({ WSL_UTF8: '1' }),
          timeoutMs: 5000
        })
      )
    })
  })

  it('runs the startup probe from the system root, never the profile (#29845)', async () => {
    runProcessMock.mockResolvedValue(exited('Ubuntu\n'))
    const saved = { SystemRoot: process.env.SystemRoot, profile: process.env.ORCA_USER_DATA_PATH }
    const systemRoot = mkdtempSync(join(tmpdir(), 'orca-wsl-probe-system-root-'))
    const profile = mkdtempSync(join(tmpdir(), 'orca-wsl-probe-profile-'))
    process.env.SystemRoot = systemRoot
    process.env.ORCA_USER_DATA_PATH = profile
    resetWslInteropSpawnDirectoryCache()
    try {
      await withPlatform('win32', () => listRunningWslDistrosAsync({ requireConfirmed: true }))
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['--list', '--running', '--quiet'], cwd: systemRoot })
      )
    } finally {
      restoreEnv('SystemRoot', saved.SystemRoot)
      restoreEnv('ORCA_USER_DATA_PATH', saved.profile)
      resetWslInteropSpawnDirectoryCache()
      rmSync(systemRoot, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('confirms an empty list when no distro runs', async () => {
    // WSL 2.7 --quiet returns empty stdout with exit 0; non-quiet output is localized and exits -1.
    runProcessMock.mockResolvedValueOnce(exited('Ubuntu\r\n')).mockResolvedValueOnce(exited(''))

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      await expect(listRunningWslDistrosAsync({ requireConfirmed: true })).resolves.toEqual([])
    })
  })

  it('fails closed when running-distro discovery fails', async () => {
    runProcessMock.mockResolvedValue(FAILED)

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
    })
  })

  it('rejects stale running state for launch admission through failure and backoff', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(exited('Ubuntu\n'))

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      runProcessMock.mockResolvedValue(FAILED)
      const paths = ['\\\\wsl.localhost\\Ubuntu\\home\\ada']
      await expect(
        filterPathsToRunningWslDistrosAsync(paths, { requireConfirmed: true })
      ).rejects.toThrow('discovery is unavailable')
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      await expect(listRunningWslDistrosAsync({ requireConfirmed: true })).rejects.toThrow(
        'discovery is unavailable'
      )
      expect(runProcessMock).toHaveBeenCalledTimes(2)

      runProcessMock.mockResolvedValue(exited(''))
      await vi.advanceTimersByTimeAsync(15_001)
      await expect(
        filterPathsToRunningWslDistrosAsync(paths, { requireConfirmed: true })
      ).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(3)
    })
  })

  it.each([true, false])(
    'shares the probe while preserving admission and observer failure policies (strict first: %s)',
    async (strictFirst) => {
      runProcessMock.mockResolvedValueOnce(exited('Ubuntu\n'))

      await withPlatform('win32', async () => {
        await listRunningWslDistrosAsync()
        let finishProbe: ((result: ProcessResult) => void) | undefined
        runProcessMock.mockImplementationOnce(
          () =>
            new Promise<ProcessResult>((resolve) => {
              finishProbe = resolve
            })
        )
        const first = listRunningWslDistrosAsync({ requireConfirmed: strictFirst })
        const second = listRunningWslDistrosAsync({ requireConfirmed: !strictFirst })
        const strict = strictFirst ? first : second
        const observer = strictFirst ? second : first
        const rejected = expect(strict).rejects.toThrow('discovery is unavailable')
        expect(runProcessMock).toHaveBeenCalledTimes(2)
        finishProbe?.(FAILED)
        await rejected
        await expect(observer).resolves.toEqual(['Ubuntu'])
        expect(runProcessMock).toHaveBeenCalledTimes(2)
      })
    }
  )

  it('resolves homes only for the running distro set', async () => {
    runProcessMock.mockImplementation(
      ({ args }: { args: string[] }) =>
        new Promise<ProcessResult>((resolve) => {
          resolve(exited(args.includes('--running') ? 'Ubuntu\n' : '/home/ada\n'))
        })
    )

    await withPlatform('win32', async () => {
      await expect(listRunningWslHomeDirsAsync()).resolves.toEqual([
        '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      ])
      expect(runProcessMock.mock.calls.map(([spec]) => spec.args)).toEqual([
        ['--list', '--running', '--quiet'],
        ['-d', 'Ubuntu', '--exec', 'bash', '-c', 'echo $HOME']
      ])
    })
  })

  it('single-flights concurrent probes without caching the result', async () => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          finishProbe = (output) => resolve(exited(output))
        })
    )

    await withPlatform('win32', async () => {
      const concurrent = [
        listRunningWslDistrosAsync(),
        listRunningWslDistrosAsync(),
        listRunningWslDistrosAsync()
      ]
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      finishProbe?.('Ubuntu\n')
      await expect(Promise.all(concurrent)).resolves.toEqual([['Ubuntu'], ['Ubuntu'], ['Ubuntu']])

      runProcessMock.mockResolvedValueOnce(exited(''))
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    })
  })

  it('single-flights cold HOME probes across concurrent callers', async () => {
    let finishList: ((output: string) => void) | undefined
    let finishHome: ((output: string) => void) | undefined
    runProcessMock.mockImplementation(
      ({ args }: { args: string[] }) =>
        new Promise<ProcessResult>((resolve) => {
          if (args.includes('--running')) {
            finishList = (output) => resolve(exited(output))
          } else {
            finishHome = (output) => resolve(exited(output))
          }
        })
    )

    await withPlatform('win32', async () => {
      const concurrent = [
        listRunningWslHomeDirsAsync(),
        listRunningWslHomeDirsAsync(),
        listRunningWslHomeDirsAsync()
      ]
      finishList?.('Ubuntu\n')
      await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledTimes(2))
      finishHome?.('/home/ada\n')

      await expect(Promise.all(concurrent)).resolves.toEqual([
        ['\\\\wsl.localhost\\Ubuntu\\home\\ada'],
        ['\\\\wsl.localhost\\Ubuntu\\home\\ada'],
        ['\\\\wsl.localhost\\Ubuntu\\home\\ada']
      ])
      expect(
        runProcessMock.mock.calls.filter(([spec]) => spec.args.includes('echo $HOME'))
      ).toHaveLength(1)
    })
  })

  it('shares a confirmed fresh probe between discovery and launch admission', async () => {
    runProcessMock.mockResolvedValueOnce(exited('Ubuntu\n'))
    await withPlatform('win32', async () => {
      expect(
        await Promise.all([
          listRunningWslDistrosAsync(),
          listRunningWslDistrosAsync({ requireConfirmed: true })
        ])
      ).toEqual([['Ubuntu'], ['Ubuntu']])
      expect(runProcessMock).toHaveBeenCalledOnce()
    })
  })

  it('filters stopped-distro UNC paths while preserving host paths', async () => {
    runProcessMock.mockResolvedValue(exited('Ubuntu\n'))

    await withPlatform('win32', async () => {
      await expect(
        filterPathsToRunningWslDistrosAsync([
          'C:\\Users\\ada\\codex-home',
          '\\\\wsl.localhost\\Ubuntu\\home\\ada',
          '\\\\wsl.localhost\\Debian\\home\\other'
        ])
      ).resolves.toEqual(['C:\\Users\\ada\\codex-home', '\\\\wsl.localhost\\Ubuntu\\home\\ada'])
    })
  })

  it('does not probe WSL on non-Windows hosts', async () => {
    await withPlatform('linux', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
      expect(runProcessMock).not.toHaveBeenCalled()
    })
  })

  it('keeps reporting a session running through a sustained wsl.exe outage, without unbounded spawns', async () => {
    let spawnCount = 0
    runProcessMock.mockImplementation(
      () =>
        new Promise<ProcessResult>((resolve) => {
          spawnCount += 1
          resolve(exited('Ubuntu\n'))
        })
    )

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(spawnCount).toBe(1)

      runProcessMock.mockImplementation(
        () =>
          new Promise<ProcessResult>((resolve) => {
            spawnCount += 1
            resolve(FAILED)
          })
      )

      vi.useFakeTimers()
      const observedStates: boolean[] = []
      const stop = observeWslTranscriptRunningState(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\a.jsonl',
        () => {
          observedStates.push(true)
        },
        () => {
          observedStates.push(false)
        }
      )

      await vi.advanceTimersByTimeAsync(30 * 60_000)
      stop()

      expect(observedStates.length).toBeGreaterThan(0)
      expect(observedStates.every((state) => state === true)).toBe(true)

      expect(spawnCount).toBeLessThan(15)
    })
  })
})
