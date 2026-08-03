import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, watchMock, resolveAuthorizedPathMock, readRangeMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  watchMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  readRangeMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('node:fs', () => ({ watch: watchMock }))

vi.mock('./filesystem-auth', () => ({ resolveAuthorizedPath: resolveAuthorizedPathMock }))

vi.mock('../ai-vault/local-log-tail-reader', () => ({
  readLocalLogTailRange: readRangeMock
}))

import {
  closeAllLocalLogTailWatchers,
  getActiveLocalLogTailWatcherCount,
  registerLocalLogTailHandlers
} from './local-log-tail'

type FakeWatcher = {
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emitError: () => void
}

function makeWatcher(): FakeWatcher {
  let errorListener: (() => void) | undefined
  return {
    close: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'error') {
        errorListener = listener
      }
    }),
    emitError: () => errorListener?.()
  }
}

function makeSender(id: number) {
  let destroyedListener: (() => void) | undefined
  return {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'destroyed') {
        destroyedListener = listener
      }
    }),
    destroy: () => destroyedListener?.()
  }
}

beforeEach(() => {
  handlers.clear()
  watchMock.mockReset()
  resolveAuthorizedPathMock.mockReset().mockImplementation(async (path: string) => path)
  readRangeMock.mockReset()
  registerLocalLogTailHandlers({} as never)
})

afterEach(() => {
  closeAllLocalLogTailWatchers()
})

describe('local log tail IPC', () => {
  it('watches only the authorized file and closes on explicit tab cancellation', async () => {
    const watcher = makeWatcher()
    let emitChange: ((eventType: 'change' | 'rename') => void) | undefined
    watchMock.mockImplementation((_path: string, listener: typeof emitChange) => {
      emitChange = listener
      return watcher
    })
    const sender = makeSender(7)

    await handlers.get('fs:startLocalLogTail')?.(
      { sender },
      { filePath: '/logs/session.jsonl', subscriptionId: 'tail-1' }
    )
    emitChange?.('change')

    expect(resolveAuthorizedPathMock).toHaveBeenCalledWith('/logs/session.jsonl', expect.anything())
    expect(watchMock).toHaveBeenCalledWith('/logs/session.jsonl', expect.any(Function))
    expect(sender.send).toHaveBeenCalledWith('fs:localLogTailChanged', {
      subscriptionId: 'tail-1',
      eventType: 'change'
    })
    expect(getActiveLocalLogTailWatcherCount()).toBe(1)

    handlers.get('fs:stopLocalLogTail')?.({ sender }, { subscriptionId: 'tail-1' })
    expect(watcher.close).toHaveBeenCalledTimes(1)
    expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  })

  it('closes every watcher owned by a destroyed renderer', async () => {
    const first = makeWatcher()
    const second = makeWatcher()
    watchMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const sender = makeSender(9)

    await handlers.get('fs:startLocalLogTail')?.(
      { sender },
      { filePath: '/logs/a.jsonl', subscriptionId: 'tail-a' }
    )
    await handlers.get('fs:startLocalLogTail')?.(
      { sender },
      { filePath: '/logs/b.jsonl', subscriptionId: 'tail-b' }
    )
    sender.destroy()

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  })
})
