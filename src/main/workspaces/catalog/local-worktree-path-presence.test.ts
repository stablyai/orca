import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock } = vi.hoisted(() => ({
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ stat: statMock }))

import {
  LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS,
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
      return { isDirectory: () => true }
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

  it('settles timed-out batches without exceeding or leaking the global stat bound', async () => {
    vi.useFakeTimers()
    const timeoutControllers = installFakeAbortSignalTimeout()
    const releaseStats: (() => void)[] = []
    let returnMissing = false
    statMock.mockImplementation(() =>
      returnMissing
        ? Promise.reject(fsError('ENOENT'))
        : new Promise((resolve) => releaseStats.push(() => resolve({ isDirectory: () => true })))
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
})
