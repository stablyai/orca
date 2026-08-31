import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock } = vi.hoisted(() => ({
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ stat: statMock }))

import {
  LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS,
  localWorktreePathExistsOrIsUnverifiable,
  localWorktreePathsExistOrAreUnverifiable
} from './local-worktree-path-presence'

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function installFakeAbortSignalTimeout(): AbortController[] {
  const controllers: AbortController[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs) => {
    const controller = new AbortController()
    controllers.push(controller)
    setTimeout(
      () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      timeoutMs
    )
    return controller.signal
  })
  return controllers
}

describe('local worktree path presence', () => {
  beforeEach(() => {
    statMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns one result per distinct path and only treats ENOENT/ENOTDIR as missing', async () => {
    statMock.mockImplementation(async (pathValue: string) => {
      if (pathValue === '/missing') {
        throw fsError('ENOENT')
      }
      if (pathValue === '/not-a-directory') {
        throw fsError('ENOTDIR')
      }
      if (pathValue === '/permission-denied') {
        throw fsError('EACCES')
      }
      return {}
    })

    const result = await localWorktreePathsExistOrAreUnverifiable([
      '/present',
      '/missing',
      '/not-a-directory',
      '/permission-denied',
      '/present'
    ])

    expect([...result.entries()]).toEqual([
      ['/present', true],
      ['/missing', false],
      ['/not-a-directory', false],
      ['/permission-denied', true]
    ])
    expect(statMock).toHaveBeenCalledTimes(4)
  })

  it('does not allocate a deadline when there are no paths to probe', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await expect(localWorktreePathsExistOrAreUnverifiable([])).resolves.toEqual(new Map())

    expect(timeout).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('globally bounds stat calls across simultaneous bulk probes', async () => {
    let active = 0
    let maximumActive = 0
    const pending: (() => void)[] = []
    statMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          pending.push(() => {
            active -= 1
            resolve({})
          })
        })
    )

    const first = localWorktreePathsExistOrAreUnverifiable([
      '/first-1',
      '/first-2',
      '/first-3',
      '/first-4'
    ])
    const second = localWorktreePathsExistOrAreUnverifiable([
      '/second-1',
      '/second-2',
      '/second-3',
      '/second-4'
    ])

    let resolved = 0
    while (resolved < 8) {
      while (pending.length === 0) {
        await Promise.resolve()
      }
      pending.shift()?.()
      resolved += 1
      await Promise.resolve()
    }

    await Promise.all([first, second])

    expect(maximumActive).toBe(2)
    expect(statMock).toHaveBeenCalledTimes(8)
  })

  it('uses the same fail-closed classification for a single probe', async () => {
    statMock.mockRejectedValueOnce(fsError('ENOENT'))
    statMock.mockRejectedValueOnce(fsError('ENOTDIR'))
    statMock.mockRejectedValueOnce(fsError('EIO'))

    await expect(localWorktreePathExistsOrIsUnverifiable('/missing')).resolves.toBe(false)
    await expect(localWorktreePathExistsOrIsUnverifiable('/parent-missing')).resolves.toBe(false)
    await expect(localWorktreePathExistsOrIsUnverifiable('/unverifiable')).resolves.toBe(true)
  })

  it('settles timed-out batches without exceeding or leaking the global stat bound', async () => {
    vi.useFakeTimers()
    const timeoutControllers = installFakeAbortSignalTimeout()
    const releaseStats: (() => void)[] = []
    let returnMissing = false
    statMock.mockImplementation(() =>
      returnMissing
        ? Promise.reject(fsError('ENOENT'))
        : new Promise((resolve) => releaseStats.push(() => resolve({})))
    )

    try {
      const firstPaths = ['/first-1', '/first-2', '/first-3', '/first-4']
      const first = localWorktreePathsExistOrAreUnverifiable(firstPaths)
      let firstSettled = false
      void first.then(() => {
        firstSettled = true
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(statMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS - 1)
      expect(firstSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toEqual(
        new Map(firstPaths.map((pathValue) => [pathValue, true]))
      )
      expect(statMock).toHaveBeenCalledTimes(2)

      const secondPaths = ['/second-1', '/second-2', '/second-3']
      const second = localWorktreePathsExistOrAreUnverifiable(secondPaths)
      await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS)
      await expect(second).resolves.toEqual(
        new Map(secondPaths.map((pathValue) => [pathValue, true]))
      )
      expect(statMock).toHaveBeenCalledTimes(2)

      returnMissing = true
      releaseStats.splice(0).forEach((release) => release())
      await vi.advanceTimersByTimeAsync(0)

      await expect(localWorktreePathsExistOrAreUnverifiable(['/after-release'])).resolves.toEqual(
        new Map([['/after-release', false]])
      )
      expect(statMock).toHaveBeenCalledTimes(3)
    } finally {
      timeoutControllers.forEach((controller) => controller.abort())
      releaseStats.splice(0).forEach((release) => release())
      await Promise.resolve()
      await Promise.resolve()
    }
  })

  it('settles promptly and fail closed when the caller aborts hung probes', async () => {
    vi.useFakeTimers()
    const timeoutControllers = installFakeAbortSignalTimeout()
    const releaseStats: (() => void)[] = []
    statMock.mockImplementation(
      () => new Promise((resolve) => releaseStats.push(() => resolve({})))
    )
    const controller = new AbortController()
    const paths = ['/abort-1', '/abort-2', '/abort-3']

    try {
      const result = localWorktreePathsExistOrAreUnverifiable(paths, {
        signal: controller.signal
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(statMock).toHaveBeenCalledTimes(2)

      controller.abort()

      await expect(result).resolves.toEqual(new Map(paths.map((pathValue) => [pathValue, true])))
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    } finally {
      timeoutControllers.forEach((timeoutController) => timeoutController.abort())
      releaseStats.splice(0).forEach((release) => release())
      await Promise.resolve()
      await Promise.resolve()
    }
  })
})
