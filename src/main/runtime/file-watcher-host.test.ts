import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'
import { WatcherProcessFailure } from '../ipc/filesystem/watcher-process/parcel-watcher-process-failure'

const {
  forgetRuntimeWatcherProcessRootMock,
  resetRuntimeWatcherProcessForTestMock,
  subscribeViaRuntimeWatcherProcessMock
} = vi.hoisted(() => ({
  forgetRuntimeWatcherProcessRootMock: vi.fn(),
  resetRuntimeWatcherProcessForTestMock: vi.fn(),
  subscribeViaRuntimeWatcherProcessMock: vi.fn()
}))

vi.mock('../ipc/filesystem/watcher-process/parcel-watcher-process', () => ({
  forgetRuntimeWatcherProcessRoot: forgetRuntimeWatcherProcessRootMock,
  resetRuntimeWatcherProcessForTest: resetRuntimeWatcherProcessForTestMock,
  subscribeViaRuntimeWatcherProcess: subscribeViaRuntimeWatcherProcessMock
}))

import {
  closeFileExplorerWatcherInWatcherProcess,
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

  it('joins root-scoped cleanup to an in-progress subscriber teardown', async () => {
    let resolveUnsubscribe: () => void = () => undefined
    const unsubscribe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve
        })
    )
    subscribeViaRuntimeWatcherProcessMock.mockResolvedValue({ unsubscribe })
    const dispose = await watchFileExplorerInWatcherProcess('/repo', vi.fn())

    let rootCloseSettled = false
    const subscriberClose = dispose()
    const rootClose = closeFileExplorerWatcherInWatcherProcess('/repo').then(() => {
      rootCloseSettled = true
    })
    await Promise.resolve()
    expect(rootCloseSettled).toBe(false)
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    resolveUnsubscribe()
    await Promise.all([subscriberClose, rootClose])
    expect(rootCloseSettled).toBe(true)
  })

  it.each([
    ['native watcher failure', new Error('native subscription stopped')],
    [
      'watcher process failure',
      new WatcherProcessFailure('crashed repeatedly', 'supervisor', 'supervisor_crash_fuse')
    ]
  ])('keeps same-root subscribers alive after a %s', async (_kind, error) => {
    const watch = installSuccessfulWatch()
    const replacement = installSuccessfulWatch()
    const firstEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const secondEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const firstError = vi.fn()
    const secondError = vi.fn()
    await watchFileExplorerInWatcherProcess('/repo', firstEvents, firstError)
    await watchFileExplorerInWatcherProcess('/repo', secondEvents, secondError)

    watch.hooks.onTerminalError?.(error)
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

  it('retains an early recovery termination failure until physical exit', async () => {
    const watch = installSuccessfulWatch()
    let rejectRecovery: ((error: Error) => void) | undefined
    subscribeViaRuntimeWatcherProcessMock.mockImplementationOnce(
      () =>
        new Promise<WatcherProcessSubscription>((_resolve, reject) => {
          rejectRecovery = reject
        })
    )
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
    const dispose = await watchFileExplorerInWatcherProcess('/repo', vi.fn())
    watch.hooks.onTerminalError?.(
      new WatcherProcessFailure('crashed repeatedly', 'supervisor', 'supervisor_crash_fuse')
    )
    await vi.waitFor(() => expect(rejectRecovery).toBeDefined())
    rejectRecovery?.(teardownError)
    await Promise.resolve()

    await expect(dispose()).rejects.toBe(teardownError)
    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).rejects.toBe(teardownError)
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(2)
    resolvePhysicalExit()
    await physicalExit
    await vi.waitFor(() =>
      expect(forgetRuntimeWatcherProcessRootMock).toHaveBeenCalledWith('/repo')
    )

    const replacement = installSuccessfulWatch()
    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).resolves.toEqual(
      expect.any(Function)
    )
    expect(replacement.unsubscribe).not.toHaveBeenCalled()
  })

  it('keeps pre-ready cancellation pending until the root can be replaced', async () => {
    let physicalSignal: AbortSignal | undefined
    let rejectPhysical: ((error: unknown) => void) | undefined
    subscribeViaRuntimeWatcherProcessMock.mockImplementationOnce(
      (_rootPath, _callback, _options, hooks: WatcherProcessHooks) => {
        physicalSignal = hooks.signal
        return new Promise<WatcherProcessSubscription>((_resolve, reject) => {
          rejectPhysical = reject
        })
      }
    )
    const controllers = [new AbortController(), new AbortController()]
    const pending = controllers.map((controller) =>
      watchFileExplorerInWatcherProcess('/repo', vi.fn(), vi.fn(), controller.signal)
    )
    const settled = [false, false]
    pending.forEach((promise, index) => {
      void promise.then(
        () => {
          settled[index] = true
        },
        () => {
          settled[index] = true
        }
      )
    })

    controllers.forEach((controller) => controller.abort())
    await Promise.resolve()

    expect(physicalSignal?.aborted).toBe(true)
    expect(settled).toEqual([false, false])

    rejectPhysical?.(
      new WatcherProcessFailure('physical watch aborted', 'subscription', 'subscribe_aborted')
    )
    const results = await Promise.allSettled(pending)
    expect(results).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'file watcher subscription aborted' })
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'file watcher subscription aborted' })
      })
    ])

    installSuccessfulWatch()
    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).resolves.toEqual(
      expect.any(Function)
    )
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(2)
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

  it('retains failed initial root ownership until the exact child physically exits', async () => {
    let resolvePhysicalExit: () => void = () => {}
    const physicalExit = new Promise<void>((resolve) => {
      resolvePhysicalExit = resolve
    })
    const teardownError = new WatcherProcessFailure(
      'initial watcher child did not exit',
      'subscription',
      'subscribe_failed',
      physicalExit
    )
    subscribeViaRuntimeWatcherProcessMock.mockRejectedValueOnce(teardownError)

    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).rejects.toBe(teardownError)
    await expect(closeFileExplorerWatcherInWatcherProcess('/repo')).rejects.toBe(teardownError)
    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).rejects.toBe(teardownError)
    expect(subscribeViaRuntimeWatcherProcessMock).toHaveBeenCalledTimes(1)
    expect(forgetRuntimeWatcherProcessRootMock).not.toHaveBeenCalled()

    resolvePhysicalExit()
    await physicalExit
    const replacement = installSuccessfulWatch()
    await expect(watchFileExplorerInWatcherProcess('/repo', vi.fn())).resolves.toEqual(
      expect.any(Function)
    )
    expect(replacement.unsubscribe).not.toHaveBeenCalled()
    await expect(closeFileExplorerWatcherInWatcherProcess('/repo')).resolves.toBeUndefined()
  })
})
