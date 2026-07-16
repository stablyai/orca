import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'
import type { FsChangeEvent } from '../../shared/types'
import { WatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'

const {
  resolveAuthorizedPathMock,
  statMock,
  watchMock,
  watchInWatcherProcessMock,
  closeWatcherInWatcherProcessMock,
  getSshFilesystemProviderMock
} = vi.hoisted(() => ({
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchMock: vi.fn(),
  watchInWatcherProcessMock: vi.fn(),
  closeWatcherInWatcherProcessMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    watch: watchMock
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    stat: statMock
  }
})

// The local (non-Windows, non-SSH) watch path delegates to the isolated watcher process.
vi.mock('./file-watcher-host', () => ({
  closeFileExplorerWatcherInWatcherProcess: closeWatcherInWatcherProcessMock,
  watchFileExplorerInWatcherProcess: watchInWatcherProcessMock
}))

vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

import {
  _getRuntimeFileWatcherReleaseCountForTests,
  _resetRuntimeFileWatcherLeasesForTests,
  awaitRuntimeFileWatcherUnsubscribes,
  RuntimeFileCommands,
  WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS
} from './orca-runtime-files'

function createWindowsWatcher(close: () => void) {
  const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
  watcher.close = vi.fn(close)
  return watcher
}

function createRuntimeFileCommands(rootPath: string) {
  const store = { getRepo: vi.fn(() => undefined) }
  const commands = new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: vi.fn(async () => ({
      id: 'wt-1',
      repoId: 'repo-1',
      path: rootPath
    })),
    resolveRuntimeFileTarget: vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: rootPath
      }
    })),
    resolveRuntimeGitTarget: vi.fn(),
    openFile: vi.fn()
  } as never)
  return { commands, store }
}

describe('RuntimeFileCommands file watching', () => {
  const originalPlatform = process.platform
  // Why: Windows runtime watches intentionally use fs.watch instead of the watcher child.
  const posixWatcherProcessIt = process.platform === 'win32' ? it.skip : it

  beforeEach(() => {
    vi.useFakeTimers()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchMock.mockReset()
    watchInWatcherProcessMock.mockReset()
    closeWatcherInWatcherProcessMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(async () => {
    await awaitRuntimeFileWatcherUnsubscribes()
    _resetRuntimeFileWatcherLeasesForTests()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    vi.useRealTimers()
  })

  it('uses a conservative Node watcher for Windows runtime file watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const watcher = createWindowsWatcher(() => {
      queueMicrotask(() => watcher.emit('close'))
    })
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return watcher
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands('C:\\repo')
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchMock).toHaveBeenCalledWith('C:\\repo', { recursive: true }, expect.any(Function))
    // Windows path does not go through the watcher child.
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()
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

  it('waits for the Windows watcher close event before allowing deletion', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const watcher = createWindowsWatcher(() => undefined)
    watchMock.mockReturnValue(watcher)
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands('C:\\repo')
    await commands.watchFileExplorer('id:wt-1', vi.fn())

    let settled = false
    const closePromise = commands.closeFileExplorerWatchersForPath('C:\\repo').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    watcher.emit('close')
    await closePromise
    expect(settled).toBe(true)
  })

  it('treats a Windows watcher error before cleanup as physical close', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const watcher = createWindowsWatcher(() => undefined)
    watchMock.mockReturnValue(watcher)
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands('C:\\repo')
    const onEvents = vi.fn()
    const onTerminalError = vi.fn()
    await commands.watchFileExplorer('id:wt-1', onEvents, onTerminalError)
    const watchError = new Error('native directory handle closed')

    watcher.emit('error', watchError)

    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
    expect(onTerminalError).toHaveBeenCalledWith(watchError)
    await expect(commands.closeFileExplorerWatchersForPath('C:\\repo')).resolves.toBeUndefined()
    expect(watcher.close).toHaveBeenCalledTimes(1)
    expect(watcher.listenerCount('close')).toBe(0)
    expect(watcher.listenerCount('error')).toBe(0)
    commands.forgetFileExplorerWatchersAfterRemoval('C:\\repo')
    expect(_getRuntimeFileWatcherReleaseCountForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains Windows close ownership until late physical exit without retry leaks', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const watcher = createWindowsWatcher(() => undefined)
    watchMock.mockReturnValue(watcher)
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands('C:\\repo')
    await commands.watchFileExplorer('id:wt-1', vi.fn())

    const closePromise = commands.closeFileExplorerWatchersForPath('C:\\repo')
    const closeResult = closePromise.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS)
    const closeError = (await closeResult) as WatcherProcessFailure
    expect(closeError).toBeInstanceOf(WatcherProcessFailure)
    expect(closeError).toMatchObject({
      message: 'Windows watcher did not close before deletion deadline',
      physicalExit: expect.any(Promise)
    })
    expect(_getRuntimeFileWatcherReleaseCountForTests()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    const retries = await Promise.allSettled(
      Array.from({ length: 100 }, () => commands.closeFileExplorerWatchersForPath('C:\\repo'))
    )
    expect(retries.every((result) => result.status === 'rejected')).toBe(true)
    expect(watcher.close).toHaveBeenCalledTimes(1)
    expect(watcher.listenerCount('close')).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    watcher.emit('close')
    await closeError.physicalExit
    await Promise.resolve()
    expect(_getRuntimeFileWatcherReleaseCountForTests()).toBe(1)
    commands.forgetFileExplorerWatchersAfterRemoval('C:\\repo')
    expect(_getRuntimeFileWatcherReleaseCountForTests()).toBe(0)
    await expect(commands.closeFileExplorerWatchersForPath('C:\\repo')).resolves.toBeUndefined()
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it('retries a failed Windows watcher close before allowing deletion', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const closeError = new Error('Windows watcher handle still active')
    const watcher = createWindowsWatcher(() => {
      if (watcher.close.mock.calls.length === 1) {
        throw closeError
      }
      queueMicrotask(() => watcher.emit('close'))
    })
    watchMock.mockReturnValue(watcher)
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands('C:\\repo')
    await commands.watchFileExplorer('id:wt-1', vi.fn())

    await expect(commands.closeFileExplorerWatchersForPath('C:\\repo')).rejects.toBe(closeError)
    await expect(commands.closeFileExplorerWatchersForPath('C:\\repo')).resolves.toBeUndefined()
    expect(watcher.close).toHaveBeenCalledTimes(2)
  })

  // Issues #5308/#8212: the local recursive watch runs out of process so the
  // blocking initial crawl and native faults cannot take down the serve runtime.
  posixWatcherProcessIt('delegates local recursive watching to the watcher process', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/home5/Brian')
    statMock.mockResolvedValue({ isDirectory: () => true })

    const captured: { cb?: (events: FsChangeEvent[]) => void } = {}
    const watcherDispose = vi.fn()
    watchInWatcherProcessMock.mockImplementation((_rootPath, cb) => {
      captured.cb = cb
      return Promise.resolve(watcherDispose)
    })

    const onEvents = vi.fn()
    const { commands } = createRuntimeFileCommands('/home5/Brian')
    const controller = new AbortController()
    const unsubscribe = await commands.watchFileExplorer(
      'id:wt-1',
      onEvents,
      vi.fn(),
      controller.signal
    )

    expect(watchInWatcherProcessMock).toHaveBeenCalledWith(
      '/home5/Brian',
      expect.any(Function),
      expect.any(Function),
      controller.signal
    )

    // Events surfaced by the watcher process reach the caller.
    captured.cb?.([{ kind: 'update', absolutePath: '/home5/Brian/a.txt', isDirectory: false }])
    expect(onEvents).toHaveBeenCalledWith([
      { kind: 'update', absolutePath: '/home5/Brian/a.txt', isDirectory: false }
    ])

    // Unsubscribe tears the subscription down (dispose runs on the shutdown-drain
    // microtask, so await the drain before asserting).
    unsubscribe()
    await awaitRuntimeFileWatcherUnsubscribes()
    expect(watcherDispose).toHaveBeenCalledTimes(1)
  })

  posixWatcherProcessIt('propagates a watcher process failure to the caller', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    watchInWatcherProcessMock.mockRejectedValue(new Error('watcher_process_failed'))
    const { commands } = createRuntimeFileCommands('/repo')

    await expect(commands.watchFileExplorer('id:wt-1', vi.fn())).rejects.toThrow(
      'watcher_process_failed'
    )
  })

  posixWatcherProcessIt(
    'retains pre-publication watcher setup ownership through destructive cleanup',
    async () => {
      resolveAuthorizedPathMock.mockResolvedValue('/repo')
      statMock.mockResolvedValue({ isDirectory: () => true })
      let resolvePhysicalExit: () => void = () => undefined
      const physicalExit = new Promise<void>((resolve) => {
        resolvePhysicalExit = resolve
      })
      const teardownError = new WatcherProcessFailure(
        'file watcher process did not exit after termination deadline',
        'supervisor',
        'process_unavailable',
        physicalExit
      )
      watchInWatcherProcessMock.mockRejectedValue(teardownError)
      closeWatcherInWatcherProcessMock.mockRejectedValueOnce(teardownError)
      const { commands } = createRuntimeFileCommands('/repo')

      await expect(commands.watchFileExplorer('id:wt-1', vi.fn())).rejects.toBe(teardownError)
      await expect(commands.closeFileExplorerWatchersForPath('/repo')).rejects.toBe(teardownError)
      expect(closeWatcherInWatcherProcessMock).toHaveBeenCalledWith('/repo')

      resolvePhysicalExit()
      await physicalExit
      await expect(commands.closeFileExplorerWatchersForPath('/repo')).resolves.toBeUndefined()
    }
  )

  posixWatcherProcessIt('rejects a runtime watch throughout destructive removal', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const watcherDispose = vi.fn()
    watchInWatcherProcessMock.mockResolvedValue(watcherDispose)
    const { commands } = createRuntimeFileCommands('/repo')
    const removal = acquireWatcherRemovalGate('/repo')
    await removal.ready

    await expect(commands.watchFileExplorer('id:wt-1', vi.fn())).rejects.toMatchObject({
      code: 'watcher_removal_in_progress'
    })
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()

    removal.release()
    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    await unsubscribe()
    expect(watchInWatcherProcessMock).toHaveBeenCalledTimes(1)
  })

  posixWatcherProcessIt('awaits root-scoped runtime watcher teardown for deletion', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const teardownError = new Error('runtime watcher teardown failed')
    const watcherDispose = vi.fn().mockRejectedValueOnce(teardownError)
    watchInWatcherProcessMock.mockResolvedValue(watcherDispose)
    const { commands } = createRuntimeFileCommands('/repo')

    await commands.watchFileExplorer('id:wt-1', vi.fn())

    await expect(commands.closeFileExplorerWatchersForPath('/repo')).rejects.toBe(teardownError)
    await expect(commands.closeFileExplorerWatchersForPath('/repo')).resolves.toBeUndefined()
    expect(watcherDispose).toHaveBeenCalledTimes(2)
  })

  posixWatcherProcessIt('re-arms a logical runtime watch after removal aborts', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const firstDispose = vi.fn().mockResolvedValue(undefined)
    const replacementDispose = vi.fn().mockResolvedValue(undefined)
    watchInWatcherProcessMock
      .mockResolvedValueOnce(firstDispose)
      .mockResolvedValueOnce(replacementDispose)
    const onEvents = vi.fn()
    const onTerminalError = vi.fn()
    const { commands } = createRuntimeFileCommands('/repo')

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents, onTerminalError)
    await commands.closeFileExplorerWatchersForPath('/repo')
    expect(firstDispose).toHaveBeenCalledTimes(1)

    await commands.restoreFileExplorerWatchersAfterFailedRemoval('/repo')

    expect(watchInWatcherProcessMock).toHaveBeenCalledTimes(2)
    expect(onTerminalError).not.toHaveBeenCalled()
    await unsubscribe()
    expect(replacementDispose).toHaveBeenCalledTimes(1)
  })

  posixWatcherProcessIt(
    're-arms a logical runtime watch after a timed-out child physically exits',
    async () => {
      resolveAuthorizedPathMock.mockResolvedValue('/repo')
      statMock.mockResolvedValue({ isDirectory: () => true })
      let resolvePhysicalExit: () => void = () => {}
      const physicalExit = new Promise<void>((resolve) => {
        resolvePhysicalExit = resolve
      })
      const teardownError = new WatcherProcessFailure(
        'file watcher process did not exit after termination deadline',
        'supervisor',
        'process_unavailable',
        physicalExit
      )
      const firstDispose = vi.fn().mockRejectedValue(teardownError)
      const replacementDispose = vi.fn().mockResolvedValue(undefined)
      watchInWatcherProcessMock
        .mockResolvedValueOnce(firstDispose)
        .mockResolvedValueOnce(replacementDispose)
      const { commands } = createRuntimeFileCommands('/repo')

      const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
      await expect(commands.closeFileExplorerWatchersForPath('/repo')).rejects.toBe(teardownError)
      await commands.restoreFileExplorerWatchersAfterFailedRemoval('/repo')
      expect(watchInWatcherProcessMock).toHaveBeenCalledTimes(1)

      resolvePhysicalExit()
      await physicalExit
      await vi.waitFor(() => expect(watchInWatcherProcessMock).toHaveBeenCalledTimes(2))

      await unsubscribe()
      expect(replacementDispose).toHaveBeenCalledTimes(1)
    }
  )

  posixWatcherProcessIt(
    'does not re-arm a stopped runtime watch after a timed-out child exits',
    async () => {
      resolveAuthorizedPathMock.mockResolvedValue('/repo')
      statMock.mockResolvedValue({ isDirectory: () => true })
      let resolvePhysicalExit: () => void = () => {}
      const physicalExit = new Promise<void>((resolve) => {
        resolvePhysicalExit = resolve
      })
      const teardownError = new WatcherProcessFailure(
        'file watcher process did not exit after termination deadline',
        'supervisor',
        'process_unavailable',
        physicalExit
      )
      const firstDispose = vi.fn().mockRejectedValue(teardownError)
      watchInWatcherProcessMock.mockResolvedValue(firstDispose)
      const { commands } = createRuntimeFileCommands('/repo')

      const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
      await expect(commands.closeFileExplorerWatchersForPath('/repo')).rejects.toBe(teardownError)
      await commands.restoreFileExplorerWatchersAfterFailedRemoval('/repo')
      await expect(unsubscribe()).rejects.toBe(teardownError)

      resolvePhysicalExit()
      await physicalExit
      await Promise.resolve()

      expect(watchInWatcherProcessMock).toHaveBeenCalledTimes(1)
      expect(_getRuntimeFileWatcherReleaseCountForTests()).toBe(0)
    }
  )

  posixWatcherProcessIt('clears a failed runtime release after physical child exit', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    let resolvePhysicalExit: () => void = () => {}
    const physicalExit = new Promise<void>((resolve) => {
      resolvePhysicalExit = resolve
    })
    const teardownError = new WatcherProcessFailure(
      'file watcher process did not exit after termination deadline',
      'supervisor',
      'process_unavailable',
      physicalExit
    )
    const watcherDispose = vi.fn().mockRejectedValue(teardownError)
    watchInWatcherProcessMock.mockResolvedValue(watcherDispose)
    const { commands } = createRuntimeFileCommands('/repo')

    await commands.watchFileExplorer('id:wt-1', vi.fn())

    await expect(commands.closeFileExplorerWatchersForPath('/repo')).rejects.toBe(teardownError)
    await expect(commands.closeFileExplorerWatchersForPath('/repo')).rejects.toBe(teardownError)
    expect(watcherDispose).toHaveBeenCalledTimes(1)

    resolvePhysicalExit()
    await physicalExit
    await Promise.resolve()

    await expect(commands.closeFileExplorerWatchersForPath('/repo')).resolves.toBeUndefined()
    expect(watcherDispose).toHaveBeenCalledTimes(1)
  })

  posixWatcherProcessIt('tracks watcher unsubscribe work so shutdown can await it', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })

    let resolveDispose: () => void = () => {}
    const disposeMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve
        })
    )
    watchInWatcherProcessMock.mockResolvedValue(disposeMock)
    const { commands } = createRuntimeFileCommands('/repo')

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    unsubscribe()

    let drained = false
    const drainPromise = awaitRuntimeFileWatcherUnsubscribes().then(() => {
      drained = true
    })
    await Promise.resolve()

    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(drained).toBe(false)

    resolveDispose()
    await drainPromise
    expect(drained).toBe(true)
  })

  it('forwards the abort signal into SSH-backed file explorer watches', async () => {
    const watch = vi.fn(async () => () => {})
    getSshFilesystemProviderMock.mockReturnValue({ watch })
    const store = { getRepo: vi.fn(() => ({ connectionId: 'ssh-1' })) }
    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => store,
      resolveWorktreeSelector: vi.fn(async () => ({
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/remote/repo'
      })),
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: {
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/remote/repo'
        },
        connectionId: 'ssh-1'
      })),
      resolveRuntimeGitTarget: vi.fn(),
      openFile: vi.fn()
    } as never)
    const controller = new AbortController()
    const onTerminalError = vi.fn()

    await commands.watchFileExplorer('id:wt-1', vi.fn(), onTerminalError, controller.signal)

    expect(watch).toHaveBeenCalledWith('/remote/repo', expect.any(Function), {
      signal: controller.signal,
      onTerminalError
    })
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()
  })
})
