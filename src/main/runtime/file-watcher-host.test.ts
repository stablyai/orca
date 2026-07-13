import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/types'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import { WatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../ipc/filesystem-watcher-ignore'

const {
  forgetRuntimeWatcherProcessRootMock,
  resetRuntimeWatcherProcessForTestMock,
  subscribeViaRuntimeWatcherProcessMock
} = vi.hoisted(() => ({
  forgetRuntimeWatcherProcessRootMock: vi.fn(),
  resetRuntimeWatcherProcessForTestMock: vi.fn(),
  subscribeViaRuntimeWatcherProcessMock: vi.fn()
}))

vi.mock('../ipc/parcel-watcher-process', () => ({
  forgetRuntimeWatcherProcessRoot: forgetRuntimeWatcherProcessRootMock,
  resetRuntimeWatcherProcessForTest: resetRuntimeWatcherProcessForTestMock,
  subscribeViaRuntimeWatcherProcess: subscribeViaRuntimeWatcherProcessMock
}))

import {
  resetRuntimeRootWatchersForTest,
  watchFileExplorerInWatcherProcess
} from './file-watcher-host'

type InstalledWatch = {
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function installSuccessfulWatch(): InstalledWatch {
  let callback: WatcherProcessCallback | undefined
  let hooks: WatcherProcessHooks | undefined
  const unsubscribe = vi.fn(async () => undefined)
  subscribeViaRuntimeWatcherProcessMock.mockImplementationOnce(
    async (
      _rootPath: string,
      nextCallback: WatcherProcessCallback,
      _options: unknown,
      nextHooks: WatcherProcessHooks
    ): Promise<WatcherProcessSubscription> => {
      callback = nextCallback
      hooks = nextHooks
      return { unsubscribe }
    }
  )
  return {
    get callback() {
      if (!callback) {
        throw new Error('watch callback not installed')
      }
      return callback
    },
    get hooks() {
      if (!hooks) {
        throw new Error('watch hooks not installed')
      }
      return hooks
    },
    unsubscribe
  }
}

describe('watchFileExplorerInWatcherProcess', () => {
  beforeEach(() => {
    forgetRuntimeWatcherProcessRootMock.mockReset()
    resetRuntimeWatcherProcessForTestMock.mockReset()
    subscribeViaRuntimeWatcherProcessMock.mockReset()
  })

  afterEach(() => {
    resetRuntimeRootWatchersForTest()
    vi.restoreAllMocks()
  })

  it('installs a bounded watch in the shared runtime watcher process', async () => {
    const watch = installSuccessfulWatch()

    const dispose = await watchFileExplorerInWatcherProcess('/repo', vi.fn())

    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledWith(
      '/repo',
      expect.any(Function),
      buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS),
      expect.objectContaining({
        delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 200 },
        onInterruption: expect.any(Function),
        onOverflow: expect.any(Function),
        onTerminalError: expect.any(Function),
        signal: expect.any(AbortSignal)
      })
    )

    const firstDispose = dispose()
    const secondDispose = dispose()
    expect(secondDispose).toBe(firstDispose)
    await firstDispose
    expect(watch.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('maps child-enriched watcher events without host-process stat work', async () => {
    const watch = installSuccessfulWatch()
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    await watchFileExplorerInWatcherProcess('/repo', onEvents)

    watch.callback(null, [
      { type: 'update', path: '/repo/file.txt', isDirectory: false },
      { type: 'create', path: '/repo/dir', isDirectory: true },
      { type: 'delete', path: '/repo/gone.txt' }
    ])

    expect(onEvents).toHaveBeenCalledWith([
      { kind: 'update', absolutePath: '/repo/file.txt', isDirectory: false },
      { kind: 'create', absolutePath: '/repo/dir', isDirectory: true },
      { kind: 'delete', absolutePath: '/repo/gone.txt', isDirectory: undefined }
    ])
  })

  it('turns child overflow and recoverable watcher errors into a conservative refresh', async () => {
    const watch = installSuccessfulWatch()
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await watchFileExplorerInWatcherProcess('/repo', onEvents)

    watch.hooks.onOverflow?.()
    watch.callback(new Error('Events were dropped by the FSEvents client.'), [])

    expect(onEvents).toHaveBeenNthCalledWith(1, [{ kind: 'overflow', absolutePath: '/repo' }])
    expect(onEvents).toHaveBeenNthCalledWith(2, [{ kind: 'overflow', absolutePath: '/repo' }])
  })

  it('refreshes only after the child has resubscribed', async () => {
    const watch = installSuccessfulWatch()
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    await watchFileExplorerInWatcherProcess('/repo', onEvents)

    watch.hooks.onInterruption?.()

    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: '/repo' }])
  })

  it('keeps same-root subscribers alive while a failed shard is replaced', async () => {
    const watch = installSuccessfulWatch()
    const replacement = installSuccessfulWatch()
    const firstEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const secondEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const firstError = vi.fn()
    const secondError = vi.fn()
    await watchFileExplorerInWatcherProcess('/repo', firstEvents, firstError)
    await watchFileExplorerInWatcherProcess('/repo', secondEvents, secondError)

    watch.hooks.onTerminalError?.(
      new WatcherProcessFailure('crashed repeatedly', 'supervisor', 'supervisor_crash_fuse')
    )
    await vi.waitFor(() => expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(2))
    watch.callback(null, [{ type: 'update', path: '/repo/late.txt' }])
    replacement.callback(null, [{ type: 'update', path: '/repo/recovered.txt' }])

    expect(firstError).not.toHaveBeenCalled()
    expect(secondError).not.toHaveBeenCalled()
    expect(firstEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: '/repo' }])
    expect(firstEvents).toHaveBeenCalledWith([
      { kind: 'update', absolutePath: '/repo/recovered.txt', isDirectory: undefined }
    ])
    expect(secondEvents).toHaveBeenCalledTimes(2)
  })

  it('ends subscribers only after isolated recovery also fails', async () => {
    const watch = installSuccessfulWatch()
    subscribeViaRuntimeWatcherProcessMock.mockRejectedValueOnce(new Error('isolated failure'))
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const onTerminalError = vi.fn()
    await watchFileExplorerInWatcherProcess('/repo', onEvents, onTerminalError)

    watch.hooks.onTerminalError?.(
      new WatcherProcessFailure('crashed repeatedly', 'supervisor', 'supervisor_crash_fuse')
    )

    await vi.waitFor(() =>
      expect(onTerminalError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'isolated failure' })
      )
    )
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: '/repo' }])
  })

  it('cancels a pending physical watch when its only client aborts', async () => {
    let physicalSignal: AbortSignal | undefined
    subscribeViaRuntimeWatcherProcessMock.mockImplementation(
      (_rootPath, _callback, _options, hooks: WatcherProcessHooks) =>
        new Promise<WatcherProcessSubscription>((_resolve, reject) => {
          physicalSignal = hooks.signal
          hooks.signal?.addEventListener(
            'abort',
            () => reject(new Error('physical watch aborted')),
            { once: true }
          )
        })
    )
    const controller = new AbortController()
    const pending = watchFileExplorerInWatcherProcess('/repo', vi.fn(), vi.fn(), controller.signal)

    controller.abort()

    await expect(pending).rejects.toThrow('aborted')
    expect(physicalSignal?.aborted).toBe(true)
  })

  it('keeps pending setup alive when another same-root client still owns it', async () => {
    let physicalSignal: AbortSignal | undefined
    let resolvePhysical: ((subscription: WatcherProcessSubscription) => void) | undefined
    const unsubscribe = vi.fn(async () => undefined)
    subscribeViaRuntimeWatcherProcessMock.mockImplementation(
      (_rootPath, _callback, _options, hooks: WatcherProcessHooks) => {
        physicalSignal = hooks.signal
        return new Promise<WatcherProcessSubscription>((resolve) => {
          resolvePhysical = resolve
        })
      }
    )
    const controller = new AbortController()
    const first = watchFileExplorerInWatcherProcess('/repo', vi.fn(), vi.fn(), controller.signal)
    const second = watchFileExplorerInWatcherProcess('/repo', vi.fn())

    controller.abort()
    await expect(first).rejects.toThrow('aborted')
    expect(physicalSignal?.aborted).toBe(false)

    resolvePhysical?.({ unsubscribe })
    await expect(second).resolves.toEqual(expect.any(Function))
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(1)
  })

  it('shares one native subscription per root across same-root callers', async () => {
    const firstRoot = installSuccessfulWatch()
    const secondRoot = installSuccessfulWatch()

    await watchFileExplorerInWatcherProcess('/repo-a', vi.fn())
    await watchFileExplorerInWatcherProcess('/repo-a', vi.fn())
    await watchFileExplorerInWatcherProcess('/repo-b', vi.fn())

    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(2)
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenNthCalledWith(
      1,
      '/repo-a',
      expect.any(Function),
      expect.any(Object),
      expect.any(Object)
    )
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenNthCalledWith(
      2,
      '/repo-b',
      expect.any(Function),
      expect.any(Object),
      expect.any(Object)
    )
    expect(firstRoot.unsubscribe).not.toHaveBeenCalled()
    expect(secondRoot.unsubscribe).not.toHaveBeenCalled()
  })

  it('stops forwarding events after the last subscriber disposes', async () => {
    const watch = installSuccessfulWatch()
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const dispose = await watchFileExplorerInWatcherProcess('/repo', onEvents)

    await dispose()
    watch.callback(null, [{ type: 'update', path: '/repo/a.txt' }])
    watch.hooks.onInterruption?.()

    expect(onEvents).not.toHaveBeenCalled()
  })

  it('propagates an initial watcher process subscription failure', async () => {
    subscribeViaRuntimeWatcherProcessMock.mockRejectedValue(new Error('watcher unavailable'))

    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).rejects.toThrow(
      'watcher unavailable'
    )
  })

  it('does not retry a root-specific initial subscription failure', async () => {
    subscribeViaRuntimeWatcherProcessMock.mockRejectedValue(
      new WatcherProcessFailure('root unavailable', 'subscription', 'subscribe_failed')
    )

    await expect(watchFileExplorerInWatcherProcess('/missing', vi.fn())).rejects.toThrow(
      'root unavailable'
    )
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(1)
  })
})
