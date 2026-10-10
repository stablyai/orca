import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import { createSshDisposalError } from '../ssh/ssh-channel-multiplexer'
import { createSshFileExplorerWatchTestConnection } from './ssh-file-explorer-watch-test-connection'

const {
  resolveAuthorizedPathMock,
  statMock,
  watchInWatcherProcessMock,
  closeWatcherInWatcherProcessMock,
  getSshFilesystemProviderMock,
  providerRegistrationListeners
} = vi.hoisted(() => ({
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchInWatcherProcessMock: vi.fn(),
  closeWatcherInWatcherProcessMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn(),
  providerRegistrationListeners: new Set<(connectionId: string) => void>()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('fs/promises')
  return { ...actual, stat: statMock }
})
vi.mock('./file-watcher-host', () => ({
  closeFileExplorerWatcherInWatcherProcess: closeWatcherInWatcherProcessMock,
  watchFileExplorerInWatcherProcess: watchInWatcherProcessMock
}))
vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../ipc/filesystem-auth')
  return { ...actual, resolveAuthorizedPath: resolveAuthorizedPathMock }
})
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.',
  onSshFilesystemProviderRegistered: (listener: (connectionId: string) => void) => {
    providerRegistrationListeners.add(listener)
    return () => providerRegistrationListeners.delete(listener)
  }
}))

import {
  _resetRuntimeFileWatcherLeasesForTests,
  awaitRuntimeFileWatcherUnsubscribes,
  RuntimeFileCommands
} from './orca-runtime-files'

const ROOT_PATH = '/home/me/repo'
const CONNECTION_ID = 'conn-1'
const OVERFLOW_EVENTS: FsChangeEvent[] = [{ kind: 'overflow', absolutePath: ROOT_PATH }]
const connections: ReturnType<typeof createSshFileExplorerWatchTestConnection>[] = []
const releases: (() => Promise<void>)[] = []

/** Drive the provider-registration hook the way a relay reconnect would. */
function emitProviderRegistered(connectionId: string): void {
  for (const listener of providerRegistrationListeners) {
    listener(connectionId)
  }
}

function createRuntimeFileCommands(): RuntimeFileCommands {
  return new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => ({ getRepo: vi.fn(() => undefined) }),
    resolveWorktreeSelector: vi.fn(async () => ({ id: 'wt-1', repoId: 'repo-1', path: ROOT_PATH })),
    resolveRuntimeFileTarget: vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: ROOT_PATH },
      executionHostId: `ssh:${CONNECTION_ID}`
    })),
    resolveRuntimeGitTarget: vi.fn(),
    openFile: vi.fn()
  } as never)
}

describe('remote file-explorer watch re-arm', () => {
  beforeEach(() => {
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchInWatcherProcessMock.mockReset()
    closeWatcherInWatcherProcessMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    providerRegistrationListeners.clear()
  })

  afterEach(async () => {
    for (const { mux } of connections) {
      mux.dispose()
    }
    for (const release of releases.splice(0)) {
      await release()
    }
    await awaitRuntimeFileWatcherUnsubscribes()
    _resetRuntimeFileWatcherLeasesForTests()
    for (const { provider } of connections.splice(0)) {
      provider.dispose()
    }
  })

  function connect() {
    const connection = createSshFileExplorerWatchTestConnection(ROOT_PATH, CONNECTION_ID)
    connections.push(connection)
    return connection
  }

  async function startInitialWatch() {
    const first = connect()
    getSshFilesystemProviderMock.mockReturnValue(first.provider)
    const watch = vi.spyOn(first.provider, 'watch')
    const commands = createRuntimeFileCommands()
    const onEvents = vi.fn()
    const controller = new AbortController()
    const onTerminalError = vi.fn(() => controller.abort())
    const setup = commands.watchFileExplorer(
      'id:wt-1',
      onEvents,
      onTerminalError,
      controller.signal
    )
    await vi.waitFor(() => expect(first.countRequests('fs.watch')).toBe(1))
    const finish = async () => {
      first.settleWatch()
      const release = await setup
      releases.push(release)
      return release
    }
    return { first, watch, onEvents, onTerminalError, controller, setup, finish }
  }

  it.each(['event', 'terminal error'] as const)(
    'fences the initial provider %s while replacement setup is pending',
    async (stage) => {
      const { first, onEvents, onTerminalError, controller, finish } = await startInitialWatch()
      const release = await finish()
      const next = connect()
      getSshFilesystemProviderMock.mockReturnValue(next.provider)
      emitProviderRegistered(CONNECTION_ID)
      await vi.waitFor(() => expect(next.countRequests('fs.watch')).toBe(1))
      if (stage === 'event') {
        first.emitChange()
      } else {
        first.failWatch('late initial failure')
      }
      expect(onEvents).not.toHaveBeenCalled()
      expect(onTerminalError).not.toHaveBeenCalled()
      expect(controller.signal.aborted).toBe(false)
      next.settleWatch()
      await vi.waitFor(() => expect(onEvents).toHaveBeenCalledExactlyOnceWith(OVERFLOW_EVENTS))
      next.emitChange()
      expect(onEvents).toHaveBeenCalledTimes(2)
      await release()
      expect(next.countRequests('fs.unwatch')).toBe(1)
    }
  )

  it('fences initial callbacks after same-provider replacement and unsubscribe', async () => {
    const { first, watch, onEvents, onTerminalError, finish } = await startInitialWatch()
    const release = await finish()
    const initialEvent = watch.mock.calls[0]?.[1]
    const initialError = watch.mock.calls[0]?.[2]?.onTerminalError
    emitProviderRegistered(CONNECTION_ID)
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledExactlyOnceWith(OVERFLOW_EVENTS))
    initialEvent?.([{ kind: 'update', absolutePath: `${ROOT_PATH}/stale.ts` }])
    initialError?.(new Error('old generation failed'))
    expect(onEvents).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    first.emitChange()
    expect(onEvents).toHaveBeenCalledTimes(2)
    await release()
    initialEvent?.([{ kind: 'update', absolutePath: `${ROOT_PATH}/closed.ts` }])
    initialError?.(new Error('closed initial watch failed'))
    expect(onEvents).toHaveBeenCalledTimes(2)
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(first.countRequests('fs.unwatch')).toBe(1)
  })

  it('delivers current initial events during setup and genuine current failures after setup', async () => {
    const { first, onEvents, onTerminalError, controller, finish } = await startInitialWatch()
    first.emitChange()
    expect(onEvents).toHaveBeenCalledOnce()
    await finish()
    first.emitChange()
    expect(onEvents).toHaveBeenCalledTimes(2)
    first.failWatch('current initial failure')
    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'current initial failure' })
    )
    expect(controller.signal.aborted).toBe(true)
  })

  it('keeps a completed initial watch armed after typed connection loss', async () => {
    const { watch, onEvents, onTerminalError, controller, finish } = await startInitialWatch()
    await finish()
    watch.mock.calls[0]?.[2]?.onTerminalError?.(createSshDisposalError('connection_lost'))
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
    const next = connect()
    getSshFilesystemProviderMock.mockReturnValue(next.provider)
    emitProviderRegistered(CONNECTION_ID)
    await vi.waitFor(() => expect(next.countRequests('fs.watch')).toBe(1))
    next.settleWatch()
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledExactlyOnceWith(OVERFLOW_EVENTS))
  })

  it.each(['connection loss', 'cancellation'] as const)(
    'rejects initial setup on %s and fences callbacks after setup ends',
    async (reason) => {
      const { first, watch, onEvents, onTerminalError, controller, setup } =
        await startInitialWatch()
      if (reason === 'connection loss') {
        first.mux.dispose('connection_lost')
        await expect(setup).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
      } else {
        controller.abort()
        await expect(setup).rejects.toMatchObject({ name: 'AbortError' })
      }
      watch.mock.calls[0]?.[1]([{ kind: 'update', absolutePath: `${ROOT_PATH}/late.ts` }])
      watch.mock.calls[0]?.[2]?.onTerminalError?.(new Error('late setup failure'))
      expect(onEvents).not.toHaveBeenCalled()
      expect(onTerminalError).not.toHaveBeenCalled()
      expect(providerRegistrationListeners.size).toBe(0)
    }
  )

  it('reinstalls and resyncs when the connection re-registers its provider', async () => {
    // Why: dispose() on transport loss stops the registration without firing onTerminalError, so
    // nothing else tells this watch it died.
    const firstUnwatch = vi.fn()
    const secondUnwatch = vi.fn()
    const firstProvider = { watch: vi.fn().mockResolvedValue(firstUnwatch) }
    const secondProvider = { watch: vi.fn().mockResolvedValue(secondUnwatch) }
    getSshFilesystemProviderMock.mockReturnValue(firstProvider)
    const commands = createRuntimeFileCommands()
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)
    expect(firstProvider.watch).toHaveBeenCalledOnce()

    getSshFilesystemProviderMock.mockReturnValue(secondProvider)
    emitProviderRegistered(CONNECTION_ID)
    await vi.waitFor(() => expect(secondProvider.watch).toHaveBeenCalledOnce())

    expect(onEvents).toHaveBeenCalledWith(OVERFLOW_EVENTS)
    // The dead transport's handle must not be closed against the fresh registration.
    expect(firstUnwatch).not.toHaveBeenCalled()
    await unsubscribe()
    expect(secondUnwatch).toHaveBeenCalledOnce()
    expect(firstUnwatch).not.toHaveBeenCalled()
  })

  it('ignores registrations for other connections', async () => {
    const watch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch })
    const commands = createRuntimeFileCommands()

    await commands.watchFileExplorer('id:wt-1', vi.fn())
    emitProviderRegistered('conn-other')
    await Promise.resolve()

    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('stops re-arming after the watch is released', async () => {
    const watch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch })
    const commands = createRuntimeFileCommands()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    await unsubscribe()
    emitProviderRegistered(CONNECTION_ID)
    await Promise.resolve()

    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('stops re-arming after the worktree is removed', async () => {
    const watch = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch })
    const commands = createRuntimeFileCommands()

    await commands.watchFileExplorer('id:wt-1', vi.fn())
    commands.forgetFileExplorerWatchersAfterRemoval(ROOT_PATH, CONNECTION_ID)
    emitProviderRegistered(CONNECTION_ID)
    await Promise.resolve()

    expect(watch).toHaveBeenCalledTimes(1)
  })
})
