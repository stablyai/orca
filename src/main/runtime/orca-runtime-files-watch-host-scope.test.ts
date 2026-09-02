import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  resolveAuthorizedPathMock,
  statMock,
  watchInWatcherProcessMock,
  watchMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { awaitRuntimeFileWatcherUnsubscribes } from './orca-runtime-files'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  it('uses a conservative Node watcher for Windows runtime file watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    watcher.close = vi.fn(() => queueMicrotask(() => watcher.emit('close')))
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return watcher
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands({ path: 'C:\\repo' })
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchMock).toHaveBeenCalledWith('C:\\repo', { recursive: true }, expect.any(Function))
    const emit = listener as (() => void) | null
    expect(emit).not.toBeNull()

    emit?.()
    emit?.()
    await vi.advanceTimersByTimeAsync(149)
    expect(onEvents).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])

    await unsubscribe()
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it('delegates local recursive watching to the watcher process', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const dispose = vi.fn()
    watchInWatcherProcessMock.mockResolvedValue(dispose)
    const { commands } = createRuntimeFileCommands()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    expect(watchInWatcherProcessMock).toHaveBeenCalledWith(
      '/repo',
      expect.any(Function),
      expect.any(Function),
      undefined
    )

    unsubscribe()
    await awaitRuntimeFileWatcherUnsubscribes()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps SSH runtime watches on the remote filesystem provider', async () => {
    const remoteDispose = vi.fn()
    const providerWatch = vi.fn(() => remoteDispose)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ watch: providerWatch } as never)
    const { commands, store } = createRuntimeFileCommands({ path: '/remote/repo' })
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(providerWatch).toHaveBeenCalledWith('/remote/repo', onEvents, {
      signal: undefined,
      onTerminalError: expect.any(Function)
    })
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()
    await unsubscribe()
    expect(remoteDispose).toHaveBeenCalledTimes(1)
  })

  it('indexes SSH runtime watches so remote deletion can await them', async () => {
    let resolveDispose: () => void = () => {}
    const remoteDispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve
        })
    )
    vi.mocked(getSshFilesystemProvider).mockReturnValue({
      watch: vi.fn(() => remoteDispose)
    } as never)
    const { commands, store } = createRuntimeFileCommands({ path: '/remote/repo' })
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    await commands.watchFileExplorer('id:wt-1', vi.fn())

    let closed = false
    const close = commands.closeFileExplorerWatchersForPath('/remote/repo', 'ssh-1').then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(remoteDispose).toHaveBeenCalledTimes(1)
    expect(closed).toBe(false)

    resolveDispose()
    await close
  })

  it('scopes same-path runtime watcher teardown to its SSH execution host', async () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    vi.mocked(getSshFilesystemProvider).mockImplementation(
      (connectionId) =>
        ({
          watch: vi.fn(() => (connectionId === 'ssh-1' ? firstDispose : secondDispose))
        }) as never
    )
    const first = createRuntimeFileCommands({ path: '/same/repo' })
    const second = createRuntimeFileCommands({ path: '/same/repo' })
    first.store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    second.store.getRepo.mockReturnValue({ connectionId: 'ssh-2' })

    await first.commands.watchFileExplorer('id:wt-1', vi.fn())
    await second.commands.watchFileExplorer('id:wt-1', vi.fn())
    await first.commands.closeFileExplorerWatchersForPath('/same/repo', 'ssh-1')

    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).not.toHaveBeenCalled()

    await second.commands.closeFileExplorerWatchersForPath('/same/repo', 'ssh-2')
    expect(secondDispose).toHaveBeenCalledTimes(1)
  })
})
