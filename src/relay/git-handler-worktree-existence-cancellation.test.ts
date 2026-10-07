import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { GitWorktreeInfo } from '../shared/worktree/types'

const { statProbe } = vi.hoisted(() => ({
  statProbe: vi.fn<(worktreePath: string) => Promise<void>>()
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statProbe
}))
vi.mock('../shared/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: vi.fn()
}))

import { annotatePrunableWorktreesByExistence } from './git-handler-worktree-list'

function listedWorktree(index: number): GitWorktreeInfo {
  return {
    path: `/remote/repo/task-${index}`,
    head: 'a'.repeat(40),
    branch: `refs/heads/task-${index}`,
    isBare: false,
    isMainWorktree: false
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  statProbe.mockReset()
})

describe('relay worktree existence cancellation', () => {
  it('rejects before eight pending stats finish and starts no more after they settle', async () => {
    const rows = Array.from({ length: 32 }, (_, index) => listedWorktree(index))
    const controller = new AbortController()
    const reason = new Error('Remote listing closed')
    const releases: (() => void)[] = []
    statProbe.mockImplementation(() => new Promise((resolve) => releases.push(resolve)))
    const outcome = vi.fn<(result: unknown) => void>()
    const observed = annotatePrunableWorktreesByExistence(rows, controller.signal).then(
      (result) => outcome(result),
      (error: unknown) => outcome(error)
    )
    try {
      await nextTurn()
      expect(statProbe).toHaveBeenCalledTimes(8)
      controller.abort(reason)
      await nextTurn()
      expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
      expect(statProbe).toHaveBeenCalledTimes(8)
    } finally {
      releases.splice(0).forEach((release) => release())
    }
    await observed
    await nextTurn()
    expect(statProbe).toHaveBeenCalledTimes(8)
    expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
    expect(rows.every((row) => row.prunable === undefined)).toBe(true)
  })

  it('starts no stats for an already-aborted request, including an empty catalog', async () => {
    const controller = new AbortController()
    const reason = new Error('Already closed')
    controller.abort(reason)
    for (const rows of [[listedWorktree(0)], []]) {
      await expect(annotatePrunableWorktreesByExistence(rows, controller.signal)).rejects.toBe(
        reason
      )
    }
    await nextTurn()
    expect(statProbe).not.toHaveBeenCalled()
  })

  it('handles synchronous abort in the first stat without abandoning rejected workers', async () => {
    const controller = new AbortController()
    const reason = new Error('First probe closed the request')
    const releases: (() => void)[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    statProbe.mockImplementation(() => {
      controller.abort(reason)
      return new Promise((resolve) => releases.push(resolve))
    })
    try {
      await expect(
        annotatePrunableWorktreesByExistence(
          Array.from({ length: 32 }, (_, index) => listedWorktree(index)),
          controller.signal
        )
      ).rejects.toBe(reason)
      expect(statProbe).toHaveBeenCalledTimes(1)
      releases.splice(0).forEach((release) => release())
      await nextTurn()
      expect(statProbe).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      releases.splice(0).forEach((release) => release())
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
