import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  _resetWslCachesForTests,
  listRunningWslDistrosAsync,
  listRunningWslHomeDirsAsync
} from './wsl'
import { filterPathsToRunningWslDistrosAsync } from './wsl-running-path-filter'
import {
  observeWslTranscriptRunningState,
  resetWslTranscriptRunningObserverForTests
} from './native-chat/wsl-transcript-running-observer'

async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

/** Default success shape from the async migration: exit 0, no timeout. */
function ok(stdout: string): unknown {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

describe('running WSL distro discovery', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    _resetWslCachesForTests()
    resetWslTranscriptRunningObserverForTests()
    vi.useRealTimers()
  })

  it('lists only running user distros without starting them', async () => {
    runProcessMock.mockImplementation(async () => ok('Ubuntu\u0000\nDocker-Desktop\u0000\n'))

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          program: 'wsl.exe',
          args: ['--list', '--running', '--quiet'],
          env: expect.objectContaining({ WSL_UTF8: '1' }),
          timeoutMs: 5000,
          // Why this matters: without a barrier a timeout here reaps only the
          // wsl.exe root and leaves whatever holds its console behind -- the
          // same execFile-timeout defect runWslProcess/probeGuestEnvironment
          // were fixed for (#19319).
          terminationBarrier: true
        })
      )
    })
  })

  it('fails closed when running-distro discovery fails', async () => {
    runProcessMock.mockRejectedValue(
      Object.assign(new Error('wsl unavailable'), { code: 'ENOENT' })
    )

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
    })
  })

  it('resolves homes only for the running distro set', async () => {
    runProcessMock.mockImplementation(async (spec: { args: readonly string[] }) =>
      ok(spec.args.includes('--running') ? 'Ubuntu\n' : '/home/ada\n')
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
        new Promise((resolve) => {
          finishProbe = (output) => resolve(ok(output))
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

      runProcessMock.mockImplementationOnce(async () => ok(''))
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    })
  })

  it('single-flights cold HOME probes across concurrent callers', async () => {
    let finishList: ((output: string) => void) | undefined
    let finishHome: ((output: string) => void) | undefined
    runProcessMock.mockImplementation(
      (spec: { args: readonly string[] }) =>
        new Promise((resolve) => {
          if (spec.args.includes('--running')) {
            finishList = (output) => resolve(ok(output))
          } else {
            finishHome = (output) => resolve(ok(output))
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

  it('filters stopped-distro UNC paths while preserving host paths', async () => {
    runProcessMock.mockImplementation(async () => ok('Ubuntu\n'))

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

  // Consumer-level: what a live transcript watcher sees when wsl.exe stays broken across
  // a whole polling session, not just a single failed call.
  it('keeps reporting a session running through a sustained wsl.exe outage, without unbounded spawns', async () => {
    let spawnCount = 0
    runProcessMock.mockImplementation(async () => {
      spawnCount += 1
      return ok('Ubuntu\n')
    })

    await withPlatform('win32', async () => {
      // Seed a real last-known-good answer before the outage starts.
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(spawnCount).toBe(1)

      // wsl.exe now fails on every call — a persistent, not transient, break.
      runProcessMock.mockImplementation(async () => {
        spawnCount += 1
        throw Object.assign(new Error('wsl unavailable'), { code: 'ENOENT' })
      })

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

      // 30 minutes of the 2s transcript-watcher poll (~900 ticks) against a broken wsl.exe.
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      stop()

      // A live session must never be reported as stopped just because discovery is broken —
      // that would make every open WSL transcript vanish out from under the user.
      expect(observedStates.length).toBeGreaterThan(0)
      expect(observedStates.every((state) => state === true)).toBe(true)

      // Backoff must keep the real wsl.exe spawn count far below one per 2s poll tick.
      expect(spawnCount).toBeLessThan(15)
    })
  })
})
