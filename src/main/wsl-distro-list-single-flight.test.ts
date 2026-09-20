import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    execFileSync: execFileSyncMock
  }
})

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  _resetWslCachesForTests,
  getCachedWslDistros,
  listWslDistros,
  listWslDistrosAsync
} from './wsl'

/** Default success shape from the async migration: exit 0, no timeout. */
function ok(stdout: string): unknown {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

// Why a dedicated file: `listWslDistrosAsync` is single-flighted, so these all turn on how a
// pending probe interacts with the synchronous twin, the cache and the retry window.
describe('WSL distro list single-flight', () => {
  // Every case here is a win32-only probe path, so the override is file-wide rather than
  // a per-test wrapper.
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    runProcessMock.mockReset()
    execFileSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  // Why: capability reads, CLI reconciliation and hook startup can all ask before the first
  // result lands. One host-wide answer should cost one physical wsl.exe spawn.
  it('single-flights concurrent asynchronous discovery', async () => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = (output) => resolve(ok(output))
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
        new Promise((resolve) => {
          finishProbe = (output) => resolve(ok(output))
        })
    )
    runProcessMock.mockImplementationOnce(async () => ok('Ubuntu\n'))

    try {
      const pending = [listWslDistrosAsync(), listWslDistrosAsync(), listWslDistrosAsync()]
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      finishProbe?.('')
      await expect(Promise.all(pending)).resolves.toEqual([[], [], []])

      // One shared empty answer arms one 15s window, not three doublings.
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

  // Why: the shared promise must never reject — every joiner gets the same fail-safe [].
  it('single-flights a concurrent failure and keeps the retry window bounded', async () => {
    vi.useFakeTimers()
    let failProbe: (() => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failProbe = () => reject(new Error('transient failure'))
        })
    )
    runProcessMock.mockImplementationOnce(async () => ok('Ubuntu\n'))

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

  // Why: `wsl --install` reports zero distros while one provisions, so a sync caller can arm
  // the empty-result retry window mid-probe. Reading that [] would strand every later caller
  // for the whole window even though the pending probe is about to see the new distro.
  it('lets a caller joining a pending probe see a distro the sync empty result hid', async () => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = (output) => resolve(ok(output))
        })
    )
    execFileSyncMock.mockReturnValue('')

    const pending = listWslDistrosAsync()
    expect(listWslDistros()).toEqual([])
    const joined = listWslDistrosAsync()
    finishProbe?.('Ubuntu\n')

    await expect(joined).resolves.toEqual(['Ubuntu'])
    await expect(pending).resolves.toEqual(['Ubuntu'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  // Why: joining is only correct while the answer can still improve. A list already found
  // synchronously is lifetime-stable, and waiting on the probe would make an answered
  // question sit out the 5s wsl.exe timeout.
  it('returns a list found synchronously without waiting on the pending probe', async () => {
    runProcessMock.mockImplementationOnce(() => new Promise(() => {}))
    execFileSyncMock.mockReturnValue('Ubuntu\n')

    void listWslDistrosAsync()
    expect(listWslDistros()).toEqual(['Ubuntu'])

    await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  // Synchronous callers stay independent, so the cache sequence guard still has to protect a
  // newer sync answer from a late async completion.
  it.each([
    ['empty', ''],
    ['different list', 'Debian\n']
  ])('does not let an older async %s result overwrite a newer sync list', async (_label, late) => {
    let finishProbe: ((output: string) => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = (output) => resolve(ok(output))
        })
    )
    execFileSyncMock.mockReturnValue('Ubuntu\n')

    const pending = listWslDistrosAsync()
    expect(listWslDistros()).toEqual(['Ubuntu'])
    finishProbe?.(late)

    await expect(pending).resolves.toEqual(['Ubuntu'])
    expect(getCachedWslDistros()).toEqual(['Ubuntu'])
  })

  // Why: a cache reset retires the pending probe, and the retired one must not clear the
  // slot its successor now owns — that would leak an extra wsl.exe spawn into the next probe.
  it('does not let a probe retired by a cache reset clear the new in-flight slot', async () => {
    const resolvers: ((output: string) => void)[] = []
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push((output) => resolve(ok(output)))
        })
    )

    const retired = listWslDistrosAsync()
    _resetWslCachesForTests()
    const fresh = listWslDistrosAsync()
    expect(resolvers).toHaveLength(2)

    resolvers[0]!('')
    await expect(retired).resolves.toEqual([])

    const joined = listWslDistrosAsync()
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    resolvers[1]!('Ubuntu\n')
    await expect(Promise.all([fresh, joined])).resolves.toEqual([['Ubuntu'], ['Ubuntu']])
  })

  // Why: N startup callers landing the same empty answer must count as ONE window; counting
  // each would double the backoff and hide a provisioning distro for twice as long. Sync and
  // async probes still overlap, so the guard is live even with the async side single-flighted.
  it('holds the base window when a sync empty result and an async failure overlap', async () => {
    vi.useFakeTimers()
    let failProbe: (() => void) | undefined
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failProbe = () => reject(new Error('transient failure'))
        })
    )
    execFileSyncMock.mockReturnValue('')

    try {
      const pending = listWslDistrosAsync()
      expect(listWslDistros()).toEqual([])
      failProbe?.()
      await expect(pending).resolves.toEqual([])

      vi.advanceTimersByTime(7_500)
      expect(listWslDistros()).toEqual([])
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(7_500)
      expect(listWslDistros()).toEqual([])
      expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
