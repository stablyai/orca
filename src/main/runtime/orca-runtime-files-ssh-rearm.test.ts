import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'

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
    await awaitRuntimeFileWatcherUnsubscribes()
    _resetRuntimeFileWatcherLeasesForTests()
  })

  it('reinstalls and resyncs when the connection re-registers its provider', async () => {
    // Why: dispose() on transport loss stops the registration without firing onTerminalError, so
    // nothing else tells this watch it died.
    const firstUnwatch = vi.fn()
    const secondUnwatch = vi.fn()
    const watch = vi.fn().mockResolvedValueOnce(firstUnwatch).mockResolvedValueOnce(secondUnwatch)
    getSshFilesystemProviderMock.mockReturnValue({ watch })
    const commands = createRuntimeFileCommands()
    const onEvents = vi.fn()

    await commands.watchFileExplorer('id:wt-1', onEvents)
    expect(watch).toHaveBeenCalledTimes(1)

    emitProviderRegistered(CONNECTION_ID)
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2))

    expect(onEvents).toHaveBeenCalledWith(OVERFLOW_EVENTS)
    // The dead transport's handle must not be closed against the fresh registration.
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
