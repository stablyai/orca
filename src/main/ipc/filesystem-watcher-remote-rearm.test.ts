import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getSshFilesystemProviderMock, providerRegistrationListeners } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    getSshFilesystemProviderMock: vi.fn(),
    providerRegistrationListeners: new Set<(connectionId: string) => void>()
  })
)

/** Drive the provider-registration hook the way a relay establish/reconnect would. */
function emitProviderRegistered(connectionId: string): void {
  for (const listener of providerRegistrationListeners) {
    listener(connectionId)
  }
}

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

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('remote filesystem watcher re-arm', () => {
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

  it('still resyncs when a fresh watch beat the failed reinstall to the retry slot', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const senderOne = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    getSshFilesystemProviderMock.mockReturnValue({ watch: vi.fn().mockResolvedValue(vi.fn()) })

    await handlers['fs:watchWorktree']({ sender: senderOne }, args)

    // Hold the reinstall's fs.watch open so a second renderer joins it and claims the retry slot first.
    let failReinstall: (error: Error) => void = () => {}
    const heldWatch = new Promise<never>((_resolve, reject) => {
      failReinstall = reject
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: vi.fn().mockReturnValue(heldWatch) })
    senderOne.send.mockClear()
    emitProviderRegistered('conn-1')

    const joinedWatch = handlers['fs:watchWorktree']({ sender: senderTwo }, args)
    const retryWatchMock = vi.fn().mockResolvedValue(vi.fn())
    failReinstall(new Error('relay not ready'))
    getSshFilesystemProviderMock.mockReturnValue({ watch: retryWatchMock })
    await joinedWatch
    await vi.advanceTimersByTimeAsync(1_000)

    // senderOne's watch really died with the old transport, so its resync must survive the merge.
    expect(retryWatchMock).toHaveBeenCalledTimes(1)
    expect(senderOne.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/home/me/repo',
      events: [{ kind: 'overflow', absolutePath: '/home/me/repo' }]
    })

    warnSpy.mockRestore()
    await closeAllWatchers()
    vi.useRealTimers()
  })
})
