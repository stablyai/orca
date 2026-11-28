// A renderer handing a folder's coverage to another watch must still get every event this watch saw but hadn't sent it.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { handleMock, subscribeMock, statMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  subscribeMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({ isDirectory: () => true })) }))
vi.mock('../../../filesystem/asar-transparent-fs', () => ({ statWithoutArchiveLock: statMock }))
vi.mock('../watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn(),
  setSharedWatcherDeliveryStallListener: vi.fn()
}))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'

type WatchCallback = (err: Error | null, events: unknown[]) => void
type Handler = (event: unknown, args: unknown) => unknown

const handlers = new Map<string, Handler>()
let emit: WatchCallback

beforeEach(async () => {
  vi.useFakeTimers()
  handleMock.mockReset()
  handleMock.mockImplementation((channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  })
  subscribeMock.mockReset()
  subscribeMock.mockImplementation(async (_dir: string, callback: WatchCallback) => {
    emit = callback
    return { unsubscribe: vi.fn().mockResolvedValue(undefined) }
  })
  statMock.mockReset()
  registerFilesystemWatcherHandlers()
  await closeAllWatchers()
})

afterEach(async () => {
  await closeAllWatchers()
  vi.useRealTimers()
})

function sender() {
  return { id: 1, isDestroyed: () => false, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}

it('hands back an edit that was queued or still flushing when the window unwatched', async () => {
  const edit = { type: 'update', path: '/repo/linked/a/b/two.md' }
  const handedBack = {
    worktreePath: '/repo/linked/a/b',
    events: [{ kind: 'update', absolutePath: edit.path }]
  }

  // Queued: the 100 ms flush window hasn't closed yet.
  const queued = sender()
  await handlers.get('fs:watchWorktree')!({ sender: queued }, { worktreePath: '/repo/linked/a/b' })
  emit(null, [edit])
  const fromQueue = handlers.get('fs:unwatchWorktree')!(
    { sender: queued },
    { worktreePath: '/repo/linked/a/b', handOver: true }
  )
  await vi.advanceTimersByTimeAsync(1_000)
  expect(queued.send).not.toHaveBeenCalledWith('fs:changed', expect.anything())
  expect(fromQueue).toEqual(handedBack)

  await closeAllWatchers()

  // Flushing: the batch left the queue and is waiting on its directory stat.
  statMock.mockReturnValue(new Promise(() => {}))
  const flushing = sender()
  await handlers.get('fs:watchWorktree')!(
    { sender: flushing },
    { worktreePath: '/repo/linked/a/b' }
  )
  emit(null, [edit])
  await vi.advanceTimersByTimeAsync(1_000)
  expect(statMock).toHaveBeenCalled()
  const fromFlush = handlers.get('fs:unwatchWorktree')!(
    { sender: flushing },
    { worktreePath: '/repo/linked/a/b', handOver: true }
  )
  expect(flushing.send).not.toHaveBeenCalledWith('fs:changed', expect.anything())
  expect(fromFlush).toEqual(handedBack)

  await closeAllWatchers()

  // Cancelled out: a file created and deleted inside the window leaves nothing to hand back.
  const cancelled = sender()
  await handlers.get('fs:watchWorktree')!(
    { sender: cancelled },
    { worktreePath: '/repo/linked/a/b' }
  )
  emit(null, [
    { type: 'create', path: edit.path },
    { type: 'delete', path: edit.path }
  ])
  expect(
    handlers.get('fs:unwatchWorktree')!(
      { sender: cancelled },
      { worktreePath: '/repo/linked/a/b', handOver: true }
    )
  ).toBeUndefined()
})
