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

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

const WORKTREE_PATH = '/home/me/repo'
const ARGS = { worktreePath: WORKTREE_PATH, connectionId: 'conn-1' }
const OVERFLOW_PAYLOAD = {
  worktreePath: WORKTREE_PATH,
  events: [{ kind: 'overflow', absolutePath: WORKTREE_PATH }]
}
const RETRY_GIVE_UP_MS = 61_000
const DORMANT_FIRST_MS = 60_000

function createSender(id: number): {
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  id: number
} {
  return { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id }
}

describe('remote filesystem watcher dormant re-arm', () => {
  const handlers: HandlerMap = {}
  let warnSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    warnSpy.mockRestore()
  })

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
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  /** Install a live watch, kill it terminally, then burn the 1s/60s fast retry window out. */
  async function installThenGiveUp(
    sender: ReturnType<typeof createSender>,
    watchAfterDeath: ReturnType<typeof vi.fn>
  ): Promise<void> {
    let onTerminalError: (error: Error) => void = () => {}
    getSshFilesystemProviderMock.mockReturnValue({
      watch: vi.fn().mockImplementation((_path, _callback, options) => {
        onTerminalError = options.onTerminalError
        return Promise.resolve(vi.fn())
      })
    })
    await handlers['fs:watchWorktree']({ sender }, ARGS)

    // The SSH link stays up: only the remote watcher dies (inotify exhaustion, relay watcher killed).
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchAfterDeath })
    onTerminalError(new Error('remote watcher died'))
    await vi.advanceTimersByTimeAsync(RETRY_GIVE_UP_MS)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)
    sender.send.mockClear()
  }

  it('re-arms after the fast retry window gives up, with no reconnect to trigger it', async () => {
    vi.useFakeTimers()
    const sender = createSender(1)
    const failingWatch = vi.fn().mockRejectedValue(new Error('inotify limit reached'))
    await installThenGiveUp(sender, failingWatch)

    const recoveredWatch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch: recoveredWatch })
    await vi.advanceTimersByTimeAsync(DORMANT_FIRST_MS)

    expect(recoveredWatch).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)

    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('backs the re-arm off instead of hammering a host that keeps refusing', async () => {
    vi.useFakeTimers()
    const sender = createSender(1)
    const failingWatch = vi.fn().mockRejectedValue(new Error('inotify limit reached'))
    await installThenGiveUp(sender, failingWatch)
    failingWatch.mockClear()

    await vi.advanceTimersByTimeAsync(DORMANT_FIRST_MS)
    expect(failingWatch).toHaveBeenCalledTimes(1)

    // Half an hour of a permanently broken remote watcher must stay in single digits, not 1s retries.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(failingWatch.mock.calls.length).toBeLessThanOrEqual(6)
    expect(failingWatch.mock.calls.length).toBeGreaterThan(1)

    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('stops re-arming once the renderer unwatches', async () => {
    vi.useFakeTimers()
    const sender = createSender(1)
    const failingWatch = vi.fn().mockRejectedValue(new Error('inotify limit reached'))
    await installThenGiveUp(sender, failingWatch)
    failingWatch.mockClear()

    handlers['fs:unwatchWorktree']({ sender }, ARGS)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(failingWatch).not.toHaveBeenCalled()

    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('leaves a dropped connection to the provider-registration re-arm', async () => {
    vi.useFakeTimers()
    const sender = createSender(1)
    const failingWatch = vi.fn().mockRejectedValue(new Error('relay gone'))
    await installThenGiveUp(sender, failingWatch)
    failingWatch.mockClear()

    // Provider gone == connection down; its registration is the cheaper trigger, so don't poll.
    getSshFilesystemProviderMock.mockReturnValue(undefined)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    const recoveredWatch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch: recoveredWatch })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(recoveredWatch).not.toHaveBeenCalled()

    for (const listener of providerRegistrationListeners) {
      listener('conn-1')
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(recoveredWatch).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', OVERFLOW_PAYLOAD)

    await closeAllWatchers()
    vi.useRealTimers()
  })
})
