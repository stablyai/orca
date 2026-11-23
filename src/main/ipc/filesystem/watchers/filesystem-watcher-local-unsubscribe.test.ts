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
import {
  closeLocalWatcherForWorktreePath,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher-local-removal'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { getLocalWatcherRoot, normalizeWatcherEventPath } from './filesystem-watcher-paths'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import { subscribeViaWatcherProcess } from '../watcher-process/parcel-watcher-process'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('local filesystem watcher unsubscribe cleanup', () => {
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

  it.each([
    ['C:\\Repo', 'c:/repo'],
    ['\\\\Server\\Share\\Repo', '//server/share/repo']
  ])('keeps the physical Windows root in event payloads for %s', async (watchPath, closePath) => {
    vi.useFakeTimers()
    try {
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
      let watcherCallback: (
        error: Error | null,
        events: { type: 'update'; path: string }[]
      ) => void = () => undefined
      const unsubscribeMock = vi.fn()
      vi.mocked(subscribeParcelWatcher).mockImplementation(async (_path, callback) => {
        watcherCallback = callback as typeof watcherCallback
        return { unsubscribe: unsubscribeMock } as never
      })
      const sender = createWatcherSender(1)

      await handlers['fs:watchWorktree']({ sender }, { worktreePath: watchPath })
      watcherCallback(null, [{ type: 'update', path: `${watchPath}\\file.txt` }])
      await vi.advanceTimersByTimeAsync(150)

      expect(sender.send).toHaveBeenCalledWith(
        'fs:changed',
        expect.objectContaining({ worktreePath: watchPath })
      )
      await closeLocalWatcherForWorktreePath(closePath)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries on a fresh generation when a listener arrives after install abort', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let replacementCallback: Parameters<typeof subscribeViaWatcherProcess>[1] = () => undefined
    const replacementUnsubscribe = vi.fn()
    vi.mocked(subscribeViaWatcherProcess)
      .mockImplementationOnce(
        (_dir, _callback, _options, hooks) =>
          new Promise((_resolve, reject) => {
            hooks?.signal?.addEventListener('abort', () => reject(new Error('subscribe aborted')), {
              once: true
            })
          })
      )
      .mockImplementationOnce(async (_dir, callback) => {
        replacementCallback = callback
        return { unsubscribe: replacementUnsubscribe }
      })
    const firstSender = createWatcherSender(1)
    const replacementSender = createWatcherSender(2)

    const firstWatch = handlers['fs:watchWorktree'](
      { sender: firstSender },
      { worktreePath: '/tmp/repo' }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(1))

    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: '/tmp/repo' })
    const replacementWatch = handlers['fs:watchWorktree'](
      { sender: replacementSender },
      { worktreePath: '/tmp/repo' }
    ) as Promise<unknown>

    await Promise.all([firstWatch, replacementWatch])
    replacementCallback(null, [{ type: 'update', path: '/tmp/repo/retry.txt' }] as never)
    await vi.waitFor(() =>
      expect(replacementSender.send).toHaveBeenCalledWith('fs:changed', {
        worktreePath: getLocalWatcherRoot('/tmp/repo').path,
        events: [
          {
            kind: 'update',
            absolutePath: normalizeWatcherEventPath('/tmp/repo/retry.txt'),
            isDirectory: true
          }
        ]
      })
    )
  })

  it('re-arms active local listeners after worktree deletion fails', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const firstUnsubscribe = vi.fn()
    const replacementUnsubscribe = vi.fn()
    vi.mocked(subscribeParcelWatcher)
      .mockResolvedValueOnce({ unsubscribe: firstUnsubscribe } as never)
      .mockResolvedValueOnce({ unsubscribe: replacementUnsubscribe } as never)
    const sender = createWatcherSender(1)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/repo' })
    await closeLocalWatcherForWorktreePath('/tmp/repo')
    await restoreLocalWatcherAfterFailedRemoval('/tmp/repo')

    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/tmp/repo',
      events: [{ kind: 'overflow', absolutePath: '/tmp/repo' }],
      resync: true
    })
  })
})
