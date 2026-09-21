import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: execFileMock
}))

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

describe('running WSL distro discovery', () => {
  afterEach(() => {
    execFileMock.mockReset()
    _resetWslCachesForTests()
    resetWslTranscriptRunningObserverForTests()
    vi.useRealTimers()
  })

  it('lists only running user distros without starting them', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, 'Ubuntu\u0000\nDocker-Desktop\u0000\n')
    })

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(execFileMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['--list', '--running', '--quiet'],
        expect.objectContaining({
          env: expect.objectContaining({ WSL_UTF8: '1' }),
          timeout: 5000,
          windowsHide: true
        }),
        expect.any(Function)
      )
    })
  })

  it('fails closed when running-distro discovery fails', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('wsl unavailable'), '')
    })

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
    })
  })

  it('resolves homes only for the running distro set', async () => {
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      callback(null, args.includes('--running') ? 'Ubuntu\n' : '/home/ada\n')
    })

    await withPlatform('win32', async () => {
      await expect(listRunningWslHomeDirsAsync()).resolves.toEqual([
        '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      ])
      expect(execFileMock.mock.calls.map(([, args]) => args)).toEqual([
        ['--list', '--running', '--quiet'],
        ['-d', 'Ubuntu', '--exec', 'bash', '-c', 'echo $HOME']
      ])
    })
  })

  it('single-flights concurrent probes without caching the result', async () => {
    let finishProbe: ((output: string) => void) | undefined
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      finishProbe = (output) => callback(null, output)
    })

    await withPlatform('win32', async () => {
      const concurrent = [
        listRunningWslDistrosAsync(),
        listRunningWslDistrosAsync(),
        listRunningWslDistrosAsync()
      ]
      expect(execFileMock).toHaveBeenCalledTimes(1)
      finishProbe?.('Ubuntu\n')
      await expect(Promise.all(concurrent)).resolves.toEqual([['Ubuntu'], ['Ubuntu'], ['Ubuntu']])

      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, '')
      })
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
      expect(execFileMock).toHaveBeenCalledTimes(2)
    })
  })

  it('single-flights cold HOME probes across concurrent callers', async () => {
    let finishList: ((output: string) => void) | undefined
    let finishHome: ((output: string) => void) | undefined
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      if (args.includes('--running')) {
        finishList = (output) => callback(null, output)
      } else {
        finishHome = (output) => callback(null, output)
      }
    })

    await withPlatform('win32', async () => {
      const concurrent = [
        listRunningWslHomeDirsAsync(),
        listRunningWslHomeDirsAsync(),
        listRunningWslHomeDirsAsync()
      ]
      finishList?.('Ubuntu\n')
      await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2))
      finishHome?.('/home/ada\n')

      await expect(Promise.all(concurrent)).resolves.toEqual([
        ['\\\\wsl.localhost\\Ubuntu\\home\\ada'],
        ['\\\\wsl.localhost\\Ubuntu\\home\\ada'],
        ['\\\\wsl.localhost\\Ubuntu\\home\\ada']
      ])
      expect(
        execFileMock.mock.calls.filter(([, args]) => args.includes('echo $HOME'))
      ).toHaveLength(1)
    })
  })

  it('filters stopped-distro UNC paths while preserving host paths', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, 'Ubuntu\n')
    })

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
      expect(execFileMock).not.toHaveBeenCalled()
    })
  })

  // Consumer-level: what a live transcript watcher sees when wsl.exe stays broken across
  // a whole polling session, not just a single failed call.
  it('keeps reporting a session running through a sustained wsl.exe outage, without unbounded spawns', async () => {
    let spawnCount = 0
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      spawnCount += 1
      callback(null, 'Ubuntu\n')
    })

    await withPlatform('win32', async () => {
      // Seed a real last-known-good answer before the outage starts.
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(spawnCount).toBe(1)

      // wsl.exe now fails on every call — a persistent, not transient, break.
      execFileMock.mockImplementation((_command, _args, _options, callback) => {
        spawnCount += 1
        callback(new Error('wsl unavailable'), '')
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
