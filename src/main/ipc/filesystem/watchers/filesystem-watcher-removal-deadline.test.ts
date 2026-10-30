import { createWatcherSender } from './filesystem-watcher-test-sender'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ParcelWatcherProcess from '../watcher-process/parcel-watcher-process'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('fs/promises', () => ({
  stat: vi.fn()
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn()
}))

vi.mock('./filesystem-watcher-wsl', () => ({
  createWslWatcher: vi.fn()
}))

vi.mock('../watcher-process/parcel-watcher-process', async (importOriginal) => {
  const actual = await importOriginal<typeof ParcelWatcherProcess>()
  return {
    ...actual,
    subscribeViaWatcherProcess: vi.fn(actual.subscribeViaWatcherProcess)
  }
})

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { closeLocalWatcherForWorktreePath } from './filesystem-watcher-local-removal'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  WATCHER_REMOVAL_DRAIN_BUDGET_MS,
  WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS
} from '../../watcher-removal-drain'
import { WatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import { subscribeViaWatcherProcess } from '../watcher-process/parcel-watcher-process'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('local filesystem watcher removal deadline', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
    vi.mocked(subscribeViaWatcherProcess).mockClear()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await closeAllWatchers()
  })

  it('bounds a wedged watcher install so worktree deletion cannot hang forever', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
      // Ignore abort once to test the drain deadline; the fallback's abort rejection would bypass it.
      vi.mocked(subscribeViaWatcherProcess).mockImplementationOnce(() => new Promise(() => {}))
      const sender = createWatcherSender(1)

      const watchPromise = handlers['fs:watchWorktree'](
        { sender },
        { worktreePath: '/tmp/repo' }
      ) as Promise<unknown>
      await vi.waitFor(() => {
        expect(subscribeViaWatcherProcess).toHaveBeenCalled()
      })

      let closed = false
      const closePromise = closeLocalWatcherForWorktreePath('/tmp/repo').then(() => {
        closed = true
      })

      // The install drain leaves the final unsubscribe its reserved tail slice.
      await vi.advanceTimersByTimeAsync(
        WATCHER_REMOVAL_DRAIN_BUDGET_MS - WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS - 1
      )
      expect(closed).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await closePromise
      expect(closed).toBe(true)

      void watchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a wedged live unsubscribe so worktree deletion cannot hang forever', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    // Fallback unsubscribe has no native deadline; the shared removal budget must bound it.
    let resolveUnsubscribe: () => void = () => {}
    const unsubscribeMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve
        })
    )
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = createWatcherSender(1)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/repo' })

    vi.useFakeTimers()
    try {
      let closed = false
      const closePromise = closeLocalWatcherForWorktreePath('/tmp/repo').then(() => {
        closed = true
      })
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS - 1)
      expect(unsubscribeMock).toHaveBeenCalledTimes(1)
      expect(closed).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await closePromise
      expect(closed).toBe(true)
    } finally {
      resolveUnsubscribe()
      vi.useRealTimers()
    }
  })

  it('spends one shared budget across both drains instead of one per await', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
      vi.mocked(subscribeViaWatcherProcess).mockImplementationOnce(() => new Promise(() => {}))
      const sender = createWatcherSender(1)

      const watchPromise = handlers['fs:watchWorktree'](
        { sender },
        { worktreePath: '/tmp/repo' }
      ) as Promise<unknown>
      await vi.waitFor(() => {
        expect(subscribeViaWatcherProcess).toHaveBeenCalled()
      })

      // A close starting halfway through a shared budget may spend only its remainder.
      const deadline = createWatcherRemovalDeadline()
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS / 2)

      let closed = false
      const closePromise = closeLocalWatcherForWorktreePath('/tmp/repo', deadline).then(() => {
        closed = true
      })
      // Check mid-drain so a fresh unshared budget cannot pass vacuously.
      await vi.advanceTimersByTimeAsync(
        WATCHER_REMOVAL_DRAIN_BUDGET_MS / 2 - WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS - 1
      )
      expect(closed).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await closePromise
      expect(closed).toBe(true)

      void watchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an abandoned unsubscribe poison a later close of the same root', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let rejectUnsubscribe: (error: unknown) => void = () => {}
    const unsubscribeMock = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectUnsubscribe = reject
        })
    )
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = createWatcherSender(1)
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/repo' })

    vi.useFakeTimers()
    try {
      const closePromise = closeLocalWatcherForWorktreePath('/tmp/repo')
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS)
      await expect(closePromise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }

    // Late failure after a completed delete must not permanently block later removal.
    rejectUnsubscribe(
      new WatcherProcessFailure(
        'file watcher process did not exit after termination deadline',
        'supervisor',
        'process_unavailable',
        new Promise<void>(() => {})
      )
    )
    await vi.waitFor(() => expect(unsubscribeMock).toHaveBeenCalledTimes(1))

    await expect(closeLocalWatcherForWorktreePath('/tmp/repo')).resolves.toBeUndefined()
  })
})

describe('watcher removal drain budget', () => {
  it('reserves a tail slice so a slow final unsubscribe is not abandoned at zero', async () => {
    vi.useFakeTimers()
    try {
      const deadline = createWatcherRemovalDeadline()
      const earlyDrain = drainBeforeWatcherRemoval(
        new Promise(() => {}),
        deadline,
        'wedged early drain',
        { reserveMs: WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS }
      )
      await vi.advanceTimersByTimeAsync(
        WATCHER_REMOVAL_DRAIN_BUDGET_MS - WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS
      )
      await expect(earlyDrain).resolves.toBe('timeout')
      expect(deadline.remainingMs()).toBe(WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS)

      let finishFinalUnsubscribe: () => void = () => {}
      const finalDrain = drainBeforeWatcherRemoval(
        new Promise<void>((resolve) => {
          finishFinalUnsubscribe = resolve
        }),
        deadline,
        'slow final unsubscribe'
      )
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS - 1)
      finishFinalUnsubscribe()

      await expect(finalDrain).resolves.toBe('settled')
    } finally {
      vi.useRealTimers()
    }
  })
})
