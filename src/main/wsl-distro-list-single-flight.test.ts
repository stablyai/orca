import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

function exited(stdout: string, code: number | null = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

const FAILED = exited('', 1)

import {
  _resetWslCachesForTests,
  getCachedWslDistros,
  listWslDistros,
  listWslDistrosAsync
} from './wsl'

describe('WSL distro list single-flight', () => {
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('single-flights concurrent asynchronous discovery', async () => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          finishProbe = (output) => resolve(exited(output))
        })
    )

    const pending = [listWslDistrosAsync(), listWslDistrosAsync(), listWslDistrosAsync()]
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    finishProbe?.('Ubuntu\n')

    await expect(Promise.all(pending)).resolves.toEqual([['Ubuntu'], ['Ubuntu'], ['Ubuntu']])
    expect(getCachedWslDistros()).toEqual(['Ubuntu'])
  })

  it('single-flights a concurrent empty result without hiding a distro installed later', async () => {
    vi.useFakeTimers()
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          finishProbe = (output) => resolve(exited(output))
        })
    )
    runProcessMock.mockResolvedValueOnce(exited('Ubuntu\n'))

    try {
      const pending = [listWslDistrosAsync(), listWslDistrosAsync(), listWslDistrosAsync()]
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      finishProbe?.('')
      await expect(Promise.all(pending)).resolves.toEqual([[], [], []])

      vi.advanceTimersByTime(14_999)
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('single-flights a concurrent failure and keeps the retry window bounded', async () => {
    vi.useFakeTimers()
    let failProbe: (() => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          failProbe = () => resolve(FAILED)
        })
    )
    runProcessMock.mockResolvedValueOnce(exited('Ubuntu\n'))

    try {
      const pending = [listWslDistrosAsync(), listWslDistrosAsync(), listWslDistrosAsync()]
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      failProbe?.()
      await expect(Promise.all(pending)).resolves.toEqual([[], [], []])

      vi.advanceTimersByTime(14_999)
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a caller joining a pending probe see a distro the sync empty result hid', async () => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          finishProbe = (output) => resolve(exited(output))
        })
    )
    runProcessSyncMock.mockReturnValue(exited(''))

    const pending = listWslDistrosAsync()
    expect(listWslDistros()).toEqual([])
    const joined = listWslDistrosAsync()
    finishProbe?.('Ubuntu\n')

    await expect(joined).resolves.toEqual(['Ubuntu'])
    await expect(pending).resolves.toEqual(['Ubuntu'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('returns a list found synchronously without waiting on the pending probe', async () => {
    runProcessMock.mockImplementationOnce(() => new Promise(() => {}))
    runProcessSyncMock.mockReturnValue(exited('Ubuntu\n'))

    void listWslDistrosAsync()
    expect(listWslDistros()).toEqual(['Ubuntu'])

    await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['empty', ''],
    ['different list', 'Debian\n']
  ])('does not let an older async %s result overwrite a newer sync list', async (_label, late) => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          finishProbe = (output) => resolve(exited(output))
        })
    )
    runProcessSyncMock.mockReturnValue(exited('Ubuntu\n'))

    const pending = listWslDistrosAsync()
    expect(listWslDistros()).toEqual(['Ubuntu'])
    finishProbe?.(late)

    await expect(pending).resolves.toEqual(['Ubuntu'])
    expect(getCachedWslDistros()).toEqual(['Ubuntu'])
  })

  it('does not let a probe retired by a cache reset clear the new in-flight slot', async () => {
    const callbacks: ((result: ProcessResult) => void)[] = []
    runProcessMock.mockImplementation(
      () =>
        new Promise<ProcessResult>((resolve) => {
          callbacks.push(resolve)
        })
    )

    const retired = listWslDistrosAsync()
    _resetWslCachesForTests()
    const fresh = listWslDistrosAsync()
    expect(callbacks).toHaveLength(2)

    callbacks[0]!(exited(''))
    await expect(retired).resolves.toEqual([])

    const joined = listWslDistrosAsync()
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    callbacks[1]!(exited('Ubuntu\n'))
    await expect(Promise.all([fresh, joined])).resolves.toEqual([['Ubuntu'], ['Ubuntu']])
  })

  it('holds the base window when a sync empty result and an async failure overlap', async () => {
    vi.useFakeTimers()
    let failProbe: (() => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise<ProcessResult>((resolve) => {
          failProbe = () => resolve(FAILED)
        })
    )
    runProcessSyncMock.mockReturnValue(exited(''))

    try {
      const pending = listWslDistrosAsync()
      expect(listWslDistros()).toEqual([])
      failProbe?.()
      await expect(pending).resolves.toEqual([])

      vi.advanceTimersByTime(7_500)
      expect(listWslDistros()).toEqual([])
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(7_500)
      expect(listWslDistros()).toEqual([])
      expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
