import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as FilesystemAuth from '../../../ipc/filesystem/access/filesystem-auth'

import { WatcherProcessFailure } from '../../../ipc/filesystem/watcher-process/parcel-watcher-process-failure'

const {
  resolveAuthorizedPathMock,
  statMock,
  watchMock,
  watchInWatcherProcessMock,
  closeWatcherInWatcherProcessMock
} = vi.hoisted(() => ({
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchMock: vi.fn(),
  watchInWatcherProcessMock: vi.fn(),
  closeWatcherInWatcherProcessMock: vi.fn()
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

vi.mock('./file-watcher-host', () => ({
  closeFileExplorerWatcherInWatcherProcess: closeWatcherInWatcherProcessMock,
  watchFileExplorerInWatcherProcess: watchInWatcherProcessMock
}))

vi.mock('../../../ipc/filesystem/access/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>(
    '../../../ipc/filesystem/access/filesystem-auth'
  )
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

import {
  _getRuntimeFileWatcherReleaseCountForTests,
  _resetRuntimeFileWatcherLeasesForTests,
  awaitRuntimeFileWatcherUnsubscribes
} from './file-watcher-leases'
import { RuntimeFileWatches } from './file-watches'
import {
  WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
  WINDOWS_RUNTIME_FILE_WATCH_LEADING_MS
} from './windows-file-watch'

function createWindowsWatcher(close: () => void) {
  const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
  watcher.close = vi.fn(close)
  return watcher
}

function createRuntimeFileWatches(rootPath: string) {
  // getSettings: file authorization reads the floating cwd; this store trusts none.
  const store = { getRepo: vi.fn(() => undefined), getSettings: () => ({}) }
  const commands = new RuntimeFileWatches({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveRuntimeFileTarget: vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: rootPath
      },
      executionHostId: 'local'
    })),
    resolveRuntimeGitTarget: vi.fn(),
    openFile: vi.fn()
    // SAFETY: Watch subjects read only the target resolver and explicitly stubbed host capabilities.
  } as never)
  return { commands, store }
}

describe('RuntimeFileWatches', () => {
  const originalPlatform = process.platform
  // Windows uses fs.watch directly instead of the watcher process.
  const posixWatcherProcessIt = process.platform === 'win32' ? it.skip : it

  beforeEach(() => {
    vi.useFakeTimers()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchMock.mockReset()
    watchInWatcherProcessMock.mockReset()
    closeWatcherInWatcherProcessMock.mockReset()
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

  it('waits for the Windows watcher close event before allowing deletion', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const watcher = createWindowsWatcher(() => undefined)
    watchMock.mockReturnValue(watcher)
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileWatches('C:\\repo')
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

  it('shares one Windows watch across clients without stopping survivors', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const watcher = createWindowsWatcher(() => watcher.emit('close'))
    let emitChange = () => undefined
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      emitChange = callback
      return watcher
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileWatches('C:\\repo')
    const callbacks = Array.from({ length: 2 }, () => vi.fn())
    const releases = await Promise.all(
      callbacks.map((callback) => commands.watchFileExplorer('id:wt-1', callback))
    )
    expect(watchMock).toHaveBeenCalledOnce()

    await releases[0]()
    expect(watcher.close).not.toHaveBeenCalled()
    emitChange()
    await vi.advanceTimersByTimeAsync(WINDOWS_RUNTIME_FILE_WATCH_LEADING_MS)
    expect(callbacks[0]).not.toHaveBeenCalled()
    for (const callback of callbacks.slice(1)) {
      expect(callback).toHaveBeenCalledExactlyOnceWith([
        { kind: 'overflow', absolutePath: 'C:\\repo' }
      ])
    }
    await Promise.all(releases.slice(1).map((release) => release()))
    expect(watcher.close).toHaveBeenCalledOnce()
    expect(_getRuntimeFileWatcherReleaseCountForTests()).toBe(0)
  })

  it('retains Windows close ownership until late physical exit without retry leaks', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const watcher = createWindowsWatcher(() => undefined)
    watchMock.mockReturnValue(watcher)
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileWatches('C:\\repo')
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
    const { commands } = createRuntimeFileWatches('/repo')

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
