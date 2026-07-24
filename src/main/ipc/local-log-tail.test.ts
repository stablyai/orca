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
  getLocalLogTailSenderCleanupCountForTest,
  getPendingLocalLogTailReadCountForTest,
  getPendingLocalLogTailStartCountForTest,
  MAX_LOCAL_LOG_TAIL_FILE_IDENTITY_BYTES,
  MAX_LOCAL_LOG_TAIL_SUBSCRIPTION_ID_BYTES,
  registerLocalLogTailHandlers
} from './local-log-tail'
import {
  MAX_LOCAL_LOG_TAIL_READS_PER_SENDER,
  MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER,
  MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE
} from './local-log-tail-operation-admission'

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
  let destroyed = false
  return {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'destroyed') {
        destroyedListener = listener
      }
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'destroyed' && destroyedListener === listener) {
        destroyedListener = undefined
      }
    }),
    destroy: () => {
      destroyed = true
      destroyedListener?.()
    }
  }
}

async function startWatch(
  sender: ReturnType<typeof makeSender>,
  subscriptionId: string,
  filePath = `/logs/${subscriptionId}.jsonl`
): Promise<void> {
  await handlers.get('fs:startLocalLogTail')?.({ sender }, { filePath, subscriptionId })
}

function stopWatch(sender: ReturnType<typeof makeSender>, subscriptionId: string): void {
  handlers.get('fs:stopLocalLogTail')?.({ sender }, { subscriptionId })
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
    expect(getLocalLogTailSenderCleanupCountForTest()).toBe(0)
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
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
    expect(getLocalLogTailSenderCleanupCountForTest()).toBe(0)
  })

  it('caps one renderer at the exact watcher limit and recovers after stop', async () => {
    watchMock.mockImplementation(() => makeWatcher())
    const sender = makeSender(10)
    for (let index = 0; index < MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER; index++) {
      await startWatch(sender, `tail-${index}`)
    }

    expect(getActiveLocalLogTailWatcherCount()).toBe(MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER)
    await expect(startWatch(sender, 'one-over')).rejects.toThrow('Too many local log tail watchers')
    expect(watchMock).toHaveBeenCalledTimes(MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER)

    stopWatch(sender, 'tail-0')
    await startWatch(sender, 'after-stop')
    expect(getActiveLocalLogTailWatcherCount()).toBe(MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER)
    expect(getLocalLogTailSenderCleanupCountForTest()).toBe(1)
  })

  it('allows same-key replacement at process capacity while rejecting a new key', async () => {
    watchMock.mockImplementation(() => makeWatcher())
    const senderCount = Math.ceil(
      MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE / MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER
    )
    const senders = Array.from({ length: senderCount + 1 }, (_, index) => makeSender(20 + index))
    for (let index = 0; index < MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE; index++) {
      const sender = senders[Math.floor(index / MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER)]
      await startWatch(sender, `global-${index}`)
    }

    await expect(startWatch(senders.at(-1)!, 'global-one-over')).rejects.toThrow(
      'Too many local log tail watchers'
    )
    await startWatch(senders[0], 'global-0', '/logs/replacement.jsonl')

    expect(getActiveLocalLogTailWatcherCount()).toBe(MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE)
    expect(watchMock).toHaveBeenCalledTimes(MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE + 1)
  })

  it('bounds pending authorization attempts and rechecks destruction before watching', async () => {
    let resolvePaths = (): void => {}
    const pathGate = new Promise<void>((resolve) => {
      resolvePaths = resolve
    })
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => {
      await pathGate
      return path
    })
    watchMock.mockImplementation(() => makeWatcher())
    const sender = makeSender(30)
    const starts = Array.from({ length: MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER }, (_, index) =>
      startWatch(sender, `pending-${index}`)
    )

    await vi.waitFor(() =>
      expect(getPendingLocalLogTailStartCountForTest()).toBe(MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER)
    )
    await expect(startWatch(sender, 'pending-one-over')).rejects.toThrow(
      'Too many local log tail starts'
    )
    sender.destroy()
    resolvePaths()
    await Promise.all(starts)

    expect(watchMock).not.toHaveBeenCalled()
    expect(getPendingLocalLogTailStartCountForTest()).toBe(0)
  })

  it('does not install a watcher after stop wins a pending authorization race', async () => {
    let authorizePath = (): void => {}
    resolveAuthorizedPathMock.mockImplementation(
      (path: string) =>
        new Promise<string>((resolve) => {
          authorizePath = () => resolve(path)
        })
    )
    watchMock.mockImplementation(() => makeWatcher())
    const sender = makeSender(31)

    const pendingStart = startWatch(sender, 'pending-stop')
    await vi.waitFor(() => expect(getPendingLocalLogTailStartCountForTest()).toBe(1))
    stopWatch(sender, 'pending-stop')
    authorizePath()
    await pendingStart

    expect(watchMock).not.toHaveBeenCalled()
    expect(getActiveLocalLogTailWatcherCount()).toBe(0)
    expect(getLocalLogTailSenderCleanupCountForTest()).toBe(0)
  })

  it('lets the newest same-key start win when authorizations resolve out of order', async () => {
    const authorizations = new Map<string, (path: string) => void>()
    resolveAuthorizedPathMock.mockImplementation(
      (path: string) =>
        new Promise<string>((resolve) => {
          authorizations.set(path, resolve)
        })
    )
    watchMock.mockImplementation(() => makeWatcher())
    const sender = makeSender(32)

    const olderStart = startWatch(sender, 'same-key', '/logs/older.jsonl')
    const newerStart = startWatch(sender, 'same-key', '/logs/newer.jsonl')
    await vi.waitFor(() => expect(authorizations.size).toBe(2))
    authorizations.get('/logs/newer.jsonl')?.('/logs/newer.jsonl')
    await newerStart
    authorizations.get('/logs/older.jsonl')?.('/logs/older.jsonl')
    await olderStart

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(watchMock).toHaveBeenCalledWith('/logs/newer.jsonl', expect.any(Function))
    expect(getActiveLocalLogTailWatcherCount()).toBe(1)
  })

  it('bounds concurrent ranged reads and releases admission after settlement', async () => {
    let resolveReads!: (value: {
      contentBase64: string
      nextByteOffset: number
      fileSize: number
      fileIdentity: string
      hasMore: boolean
      reset: boolean
    }) => void
    const readGate = new Promise<{
      contentBase64: string
      nextByteOffset: number
      fileSize: number
      fileIdentity: string
      hasMore: boolean
      reset: boolean
    }>((resolve) => {
      resolveReads = resolve
    })
    readRangeMock.mockReturnValue(readGate)
    const sender = makeSender(33)
    const read = handlers.get('fs:readLocalLogTail')!
    const reads = Array.from({ length: MAX_LOCAL_LOG_TAIL_READS_PER_SENDER }, () =>
      read({ sender }, { filePath: '/logs/session.jsonl', fromByteOffset: 0 })
    )

    await vi.waitFor(() =>
      expect(getPendingLocalLogTailReadCountForTest()).toBe(MAX_LOCAL_LOG_TAIL_READS_PER_SENDER)
    )
    await expect(
      read({ sender }, { filePath: '/logs/session.jsonl', fromByteOffset: 0 })
    ).rejects.toThrow('Too many concurrent local log tail reads')
    resolveReads({
      contentBase64: '',
      nextByteOffset: 0,
      fileSize: 0,
      fileIdentity: 'identity',
      hasMore: false,
      reset: false
    })
    await Promise.all(reads)

    expect(readRangeMock).toHaveBeenCalledTimes(MAX_LOCAL_LOG_TAIL_READS_PER_SENDER)
    expect(getPendingLocalLogTailReadCountForTest()).toBe(0)
  })

  it('rejects an oversized UTF-8 subscription id before path authorization', async () => {
    const sender = makeSender(34)
    const oversizedId = '😀'.repeat(Math.floor(MAX_LOCAL_LOG_TAIL_SUBSCRIPTION_ID_BYTES / 4) + 1)

    await expect(startWatch(sender, oversizedId)).rejects.toThrow(
      'Invalid local log tail subscription id'
    )
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('validates and snapshots ranged-read fields before path authorization', async () => {
    let authorizePath = (): void => {}
    resolveAuthorizedPathMock.mockImplementation(
      (path: string) =>
        new Promise<string>((resolve) => {
          authorizePath = () => resolve(path)
        })
    )
    readRangeMock.mockResolvedValue({
      contentBase64: '',
      nextByteOffset: 7,
      fileSize: 7,
      fileIdentity: 'identity-before',
      hasMore: false,
      reset: false
    })
    const sender = makeSender(35)
    const args = {
      filePath: '/logs/session.jsonl',
      fromByteOffset: 7,
      expectedIdentity: 'identity-before'
    }

    const pendingRead = handlers.get('fs:readLocalLogTail')?.({ sender }, args)
    args.fromByteOffset = 99
    args.expectedIdentity = 'identity-after'
    authorizePath()
    await pendingRead

    expect(readRangeMock).toHaveBeenCalledWith('/logs/session.jsonl', 7, 'identity-before')

    await expect(
      handlers.get('fs:readLocalLogTail')?.(
        { sender },
        {
          filePath: '/logs/session.jsonl',
          fromByteOffset: 0,
          expectedIdentity: '😀'.repeat(Math.floor(MAX_LOCAL_LOG_TAIL_FILE_IDENTITY_BYTES / 4) + 1)
        }
      )
    ).rejects.toThrow('Invalid local log tail file identity')
    expect(resolveAuthorizedPathMock).toHaveBeenCalledTimes(1)
  })
})
