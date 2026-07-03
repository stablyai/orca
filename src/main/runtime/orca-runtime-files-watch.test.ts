import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'
import type { FsChangeEvent } from '../../shared/types'

const { resolveAuthorizedPathMock, statMock, watchMock, watchInWorkerMock } = vi.hoisted(() => ({
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchMock: vi.fn(),
  watchInWorkerMock: vi.fn()
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

// The local (non-Windows, non-SSH) watch path now delegates to a worker thread.
vi.mock('./file-watcher-host', () => ({
  watchFileExplorerInWorker: watchInWorkerMock
}))

vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

import { awaitRuntimeFileWatcherUnsubscribes, RuntimeFileCommands } from './orca-runtime-files'

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
  // Why: Windows runtime watches intentionally use fs.watch instead of the worker path.
  const posixWorkerIt = process.platform === 'win32' ? it.skip : it

  beforeEach(() => {
    vi.useFakeTimers()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchMock.mockReset()
    watchInWorkerMock.mockReset()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(async () => {
    await awaitRuntimeFileWatcherUnsubscribes()
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

    const close = vi.fn()
    const on = vi.fn()
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return { close, on }
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands('C:\\repo')
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchMock).toHaveBeenCalledWith('C:\\repo', { recursive: true }, expect.any(Function))
    // Windows path does not go through the worker.
    expect(watchInWorkerMock).not.toHaveBeenCalled()
    const emit = listener as (() => void) | null
    expect(emit).not.toBeNull()

    emit?.()
    emit?.()
    await vi.advanceTimersByTimeAsync(149)
    expect(onEvents).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])

    unsubscribe()
    expect(close).toHaveBeenCalledTimes(1)
  })

  // Issue #5308: the local recursive watch runs in a worker thread so
  // @parcel/watcher's blocking initial crawl can't starve the serve runtime.
  posixWorkerIt('delegates local recursive watching to the worker thread', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/home5/Brian')
    statMock.mockResolvedValue({ isDirectory: () => true })

    const captured: { cb?: (events: FsChangeEvent[]) => void } = {}
    const workerDispose = vi.fn()
    watchInWorkerMock.mockImplementation((_rootPath, cb) => {
      captured.cb = cb
      return Promise.resolve(workerDispose)
    })

    const onEvents = vi.fn()
    const { commands } = createRuntimeFileCommands('/home5/Brian')
    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchInWorkerMock).toHaveBeenCalledWith('/home5/Brian', expect.any(Function))

    // Events surfaced by the worker reach the caller.
    captured.cb?.([{ kind: 'update', absolutePath: '/home5/Brian/a.txt', isDirectory: false }])
    expect(onEvents).toHaveBeenCalledWith([
      { kind: 'update', absolutePath: '/home5/Brian/a.txt', isDirectory: false }
    ])

    // Unsubscribe tears the worker down (dispose runs on the shutdown-drain
    // microtask, so await the drain before asserting).
    unsubscribe()
    await awaitRuntimeFileWatcherUnsubscribes()
    expect(workerDispose).toHaveBeenCalledTimes(1)
  })

  posixWorkerIt('propagates a worker watch failure to the caller', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    watchInWorkerMock.mockRejectedValue(new Error('worker_failed'))
    const { commands } = createRuntimeFileCommands('/repo')

    await expect(commands.watchFileExplorer('id:wt-1', vi.fn())).rejects.toThrow('worker_failed')
  })

  posixWorkerIt('tracks worker unsubscribe work so shutdown can await it', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })

    let resolveDispose: () => void = () => {}
    const disposeMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve
        })
    )
    watchInWorkerMock.mockResolvedValue(disposeMock)
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
})
