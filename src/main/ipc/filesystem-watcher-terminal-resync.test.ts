import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getSshFilesystemProviderMock, providerRegistrationListeners } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    getSshFilesystemProviderMock: vi.fn(),
    providerRegistrationListeners: new Set<(connectionId: string) => void>()
  })
)

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({ stat: vi.fn() }))
vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  onSshFilesystemProviderRegistered: (listener: (connectionId: string) => void) => {
    providerRegistrationListeners.add(listener)
    return () => providerRegistrationListeners.delete(listener)
  }
}))

import {
  closeAllWatchers,
  closeRemoteWatcherForWorktreePath,
  forgetRemoteWatcherRemovalSnapshot,
  registerFilesystemWatcherHandlers,
  restoreRemoteWatcherAfterFailedRemoval
} from './filesystem-watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>
type TerminalErrorHandler = (error: Error) => void

const WORKTREE_PATH = '/home/me/repo'
const ARGS = { worktreePath: WORKTREE_PATH, connectionId: 'conn-1' }
const OVERFLOW_PAYLOAD = {
  worktreePath: WORKTREE_PATH,
  events: [{ kind: 'overflow', absolutePath: WORKTREE_PATH }]
}

type MockSender = {
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  id: number
  destroy: () => void
}

function createSender(id: number): MockSender {
  let destroyed = false
  const destroyedHandlers: (() => void)[] = []
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'destroyed') {
        destroyedHandlers.push(handler)
      }
    }),
    id,
    destroy: () => {
      destroyed = true
      for (const handler of destroyedHandlers) {
        handler()
      }
    }
  }
}

describe('remote filesystem watcher terminal retry resync', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
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
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('resyncs only owners still watching when the terminal retry installs', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const senderOne = createSender(1)
    const senderTwo = createSender(2)
    let terminalError: TerminalErrorHandler = () => {}
    let resolveRetry: (unwatch: () => void) => void = () => {}
    const retryInstall = new Promise<() => void>((resolve) => {
      resolveRetry = resolve
    })
    const watchMock = vi
      .fn()
      .mockImplementationOnce((_path, _events, options) => {
        terminalError = options.onTerminalError
        return Promise.resolve(vi.fn())
      })
      .mockReturnValueOnce(retryInstall)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender: senderOne }, ARGS)
    await handlers['fs:watchWorktree']({ sender: senderTwo }, ARGS)
    terminalError(new Error('relay watcher died'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchMock).toHaveBeenCalledTimes(2)

    handlers['fs:unwatchWorktree']({ sender: senderOne }, ARGS)
    resolveRetry(vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    expect(senderOne.send).not.toHaveBeenCalled()
    expect(senderTwo.send).toHaveBeenCalledTimes(1)
    expect(senderTwo.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)

    terminalError(new Error('late stale failure'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(senderTwo.send).toHaveBeenCalledTimes(1)
  })

  it('does not resync a fast retry for an initial setup failure', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    const watchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider not ready'))
      .mockResolvedValueOnce(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('lets provider registration supersede a pending terminal retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    terminalError(new Error('old relay watcher died'))
    for (const listener of providerRegistrationListeners) {
      listener('conn-1')
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight terminal retry when a replacement provider registers', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    let retrySignal: AbortSignal | undefined
    let resolveRetry: (unwatch: () => void) => void = () => {}
    const retryInstall = new Promise<() => void>((resolve) => {
      resolveRetry = resolve
    })
    const retryUnwatch = vi.fn()
    const staleWatch = vi
      .fn()
      .mockImplementationOnce((_path, _events, options) => {
        terminalError = options.onTerminalError
        return Promise.resolve(vi.fn())
      })
      .mockImplementationOnce((_path, _events, options) => {
        retrySignal = options.signal
        return retryInstall
      })
    const replacementWatch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch: staleWatch })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    terminalError(new Error('old relay watcher died'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(staleWatch).toHaveBeenCalledTimes(2)

    getSshFilesystemProviderMock.mockReturnValue({ watch: replacementWatch })
    for (const listener of providerRegistrationListeners) {
      listener('conn-1')
    }
    expect(retrySignal?.aborted).toBe(true)

    resolveRetry(retryUnwatch)
    await vi.advanceTimersByTimeAsync(0)

    expect(retryUnwatch).toHaveBeenCalledTimes(1)
    expect(replacementWatch).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)
  })

  it('coalesces repeated terminal recovery resyncs with a trailing refresh', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    const terminalErrors: TerminalErrorHandler[] = []
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalErrors.push(options.onTerminalError)
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    terminalErrors[0]?.(new Error('first watcher failure'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sender.send).toHaveBeenCalledTimes(1)

    terminalErrors[1]?.(new Error('second watcher failure'))
    await vi.advanceTimersByTimeAsync(1_000)
    terminalErrors[2]?.(new Error('third watcher failure'))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).toHaveBeenCalledTimes(4)
    expect(sender.send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenLastCalledWith('fs:changed', OVERFLOW_PAYLOAD)
  })

  it('cancels a terminal retry when the last owner unwatches', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    terminalError(new Error('relay watcher died'))
    handlers['fs:unwatchWorktree']({ sender }, ARGS)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('cancels a terminal retry when removal forgets the watcher snapshot', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    terminalError(new Error('relay watcher died'))
    forgetRemoteWatcherRemovalSnapshot('conn-1', WORKTREE_PATH)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('cancels a terminal retry when its renderer is destroyed', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    terminalError(new Error('relay watcher died'))
    sender.destroy()
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('does not retry a terminal callback raised during destructive removal', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    let resolveClose: () => void = () => {}
    const closeWatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        })
    )
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock, closeWatch })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    const close = closeRemoteWatcherForWorktreePath('conn-1', WORKTREE_PATH)
    await Promise.resolve()
    terminalError(new Error('close terminated watcher'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()

    resolveClose()
    await close
    forgetRemoteWatcherRemovalSnapshot('conn-1', WORKTREE_PATH)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('restores once after removal teardown rejects with a terminal callback', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    let rejectClose: (error: Error) => void = () => {}
    const closeWatch = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = reject
        })
    )
    const watchMock = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(vi.fn())
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock, closeWatch })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    const close = closeRemoteWatcherForWorktreePath('conn-1', WORKTREE_PATH)
    await Promise.resolve()
    terminalError(new Error('close terminated watcher'))
    rejectClose(new Error('close failed'))
    await expect(close).rejects.toThrow('close failed')
    await restoreRemoteWatcherAfterFailedRemoval('conn-1', WORKTREE_PATH)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)
  })

  it('does not carry a shutdown terminal callback into a reopened lifecycle', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createSender(1)
    let terminalError: TerminalErrorHandler = () => {}
    const initialWatch = vi.fn().mockImplementation((_path, _events, options) => {
      terminalError = options.onTerminalError
      return Promise.resolve(() => terminalError(new Error('shutdown terminated watcher')))
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: initialWatch })

    await handlers['fs:watchWorktree']({ sender }, ARGS)
    await closeAllWatchers()

    const reopenedWatch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch: reopenedWatch })
    await handlers['fs:watchWorktree']({ sender }, ARGS)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(initialWatch).toHaveBeenCalledTimes(1)
    expect(reopenedWatch).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })
})
