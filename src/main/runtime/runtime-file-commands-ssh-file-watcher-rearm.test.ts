import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import {
  createSshDisposalError,
  SSH_MUX_REQUEST_TIMEOUT_CODE
} from '../ssh/ssh-channel-multiplexer'
import { createSshFileExplorerWatchTestConnection as createWatchConnection } from './ssh-file-explorer-watch-test-connection'
import { armSshFileExplorerWatchRearm } from './runtime-file-commands-ssh-file-watcher-rearm'

type WatchProvider = Pick<IFilesystemProvider, 'watch'>

const { getProvider, registrationListeners, rearms } = vi.hoisted(() => ({
  getProvider: vi.fn<(connectionId: string) => WatchProvider | undefined>(),
  registrationListeners: new Set<(connectionId: string) => void>(),
  rearms: new Map<string, Set<() => void>>()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getProvider,
  onSshFilesystemProviderRegistered: (listener: (connectionId: string) => void) => {
    registrationListeners.add(listener)
    return () => registrationListeners.delete(listener)
  }
}))

vi.mock('./runtime-file-commands-mobile-file-list-limit', () => ({
  runtimeWatcherReleaseKey: (runtimeId: string, connectionId: string, rootPath: string) =>
    `${runtimeId}:${connectionId}:${rootPath}`,
  sshFileExplorerWatchRearms: rearms
}))

function registerProvider(provider: WatchProvider): void {
  getProvider.mockReturnValue(provider)
  for (const listener of registrationListeners) {
    listener('ssh-1')
  }
}

function pendingWatch() {
  let resolve: (unwatch: () => void) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<() => void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { watch: vi.fn<IFilesystemProvider['watch']>(() => promise), resolve, reject }
}

describe('SSH file explorer watcher rearm', () => {
  let unsubscribe: (() => Promise<void>) | undefined
  const connections: ReturnType<typeof createWatchConnection>[] = []

  beforeEach(() => {
    getProvider.mockReset()
    registrationListeners.clear()
    rearms.clear()
  })

  afterEach(async () => {
    for (const { mux } of connections) {
      mux.dispose()
    }
    await unsubscribe?.()
    unsubscribe = undefined
    for (const { provider } of connections.splice(0)) {
      provider.dispose()
    }
    expect(registrationListeners.size).toBe(0)
    expect(rearms.size).toBe(0)
  })

  function install(
    initialProvider: WatchProvider = { watch: vi.fn() },
    initialUnwatch: () => void = vi.fn()
  ) {
    if (!getProvider.getMockImplementation()) {
      getProvider.mockReturnValue(initialProvider)
    }
    const onEvents = vi.fn()
    const controller = new AbortController()
    const onTerminalError = vi.fn((_error: Error) => controller.abort())
    const rearm = armSshFileExplorerWatchRearm({
      runtimeId: 'runtime-1',
      connectionId: 'ssh-1',
      rootPath: '/remote/repo',
      callback: onEvents,
      onTerminalError,
      signal: controller.signal,
      initialUnwatch,
      initialProvider
    })
    unsubscribe = rearm.unsubscribe
    return { onEvents, onTerminalError, initialUnwatch, controller }
  }

  it('ignores a superseded setup failure and installs the current provider', async () => {
    const { onEvents, onTerminalError, controller } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())

    const currentUnwatch = vi.fn()
    const current = { watch: vi.fn(async () => currentUnwatch) }
    registerProvider(current)
    old.reject(new Error('previous transport disconnected'))

    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
    expect(onEvents).toHaveBeenCalledExactlyOnceWith([
      { kind: 'overflow', absolutePath: '/remote/repo' }
    ])
    await unsubscribe?.()
    expect(currentUnwatch).toHaveBeenCalledOnce()
  })

  it('replaces an initial watch whose provider changed before rearm was installed', async () => {
    const original = pendingWatch()
    const initialUnwatch = vi.fn()
    const initialSetup = original.watch('/remote/repo', vi.fn())
    const currentUnwatch = vi.fn()
    const current = { watch: vi.fn(async () => currentUnwatch) }
    registerProvider(current)
    original.resolve(initialUnwatch)
    await initialSetup
    const { onEvents, onTerminalError } = install(original, initialUnwatch)

    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    expect(current.watch).toHaveBeenCalledOnce()
    expect(initialUnwatch).not.toHaveBeenCalled()
    expect(onTerminalError).not.toHaveBeenCalled()
    await unsubscribe?.()
    expect(currentUnwatch).toHaveBeenCalledOnce()
    expect(initialUnwatch).not.toHaveBeenCalled()
  })

  it('coalesces registrations that arrive before replacement setup starts', async () => {
    const { onEvents } = install()
    const old = { watch: vi.fn(async () => vi.fn()) }
    const current = { watch: vi.fn(async () => vi.fn()) }
    registerProvider(old)
    registerProvider(current)

    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    expect(old.watch).not.toHaveBeenCalled()
    expect(current.watch).toHaveBeenCalledOnce()
  })

  it('closes a superseded successful setup without publishing its refresh', async () => {
    const { onEvents, onTerminalError } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
    const currentUnwatch = vi.fn()
    const current = { watch: vi.fn(async () => currentUnwatch) }
    registerProvider(current)
    const obsoleteUnwatch = vi.fn()
    old.resolve(obsoleteUnwatch)

    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    expect(obsoleteUnwatch).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(onEvents).toHaveBeenCalledOnce()
    await unsubscribe?.()
    expect(currentUnwatch).toHaveBeenCalledOnce()
  })

  it('reports a genuine current-provider setup failure', async () => {
    const { onTerminalError, onEvents } = install()
    const error = new Error('current host refused watch')
    registerProvider({
      watch: vi.fn(async () => {
        throw error
      })
    })

    await vi.waitFor(() => expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(error))
    expect(onEvents).not.toHaveBeenCalled()
  })

  it.each(['setup', 'terminal callback'] as const)(
    'waits for registration after a current-provider %s loses its connection',
    async (stage) => {
      const { onTerminalError, onEvents, controller } = install()
      const lost = pendingWatch()
      registerProvider(lost)
      await vi.waitFor(() => expect(lost.watch).toHaveBeenCalledOnce())
      const error = createSshDisposalError('connection_lost')
      if (stage === 'setup') {
        lost.reject(error)
      } else {
        lost.resolve(vi.fn())
        await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
        lost.watch.mock.calls[0]?.[2]?.onTerminalError?.(error)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(onTerminalError).not.toHaveBeenCalled()
      expect(controller.signal.aborted).toBe(false)

      const currentUnwatch = vi.fn()
      const current = { watch: vi.fn(async () => currentUnwatch) }
      registerProvider(current)
      await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
      expect(onEvents).toHaveBeenLastCalledWith([
        { kind: 'overflow', absolutePath: '/remote/repo' }
      ])
      await unsubscribe?.()
      expect(currentUnwatch).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['shutdown', createSshDisposalError('shutdown')],
    [
      'timeout',
      Object.assign(new Error('watch timed out'), { code: SSH_MUX_REQUEST_TIMEOUT_CODE })
    ],
    ['uncoded connection message', new Error('CONNECTION_LOST')]
  ])('reports a current-provider %s setup failure', async (_label, error) => {
    const { onTerminalError } = install()
    registerProvider({
      watch: vi.fn(async () => {
        throw error
      })
    })
    await vi.waitFor(() => expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(error))
  })

  it.each(['active', 'canceled'] as const)(
    'keeps an %s owner correct through actual multiplexer loss and later registration',
    async (owner) => {
      const connect = () => {
        const connection = createWatchConnection()
        connections.push(connection)
        return connection
      }
      const first = connect()
      getProvider.mockReturnValue(first.provider)
      const initialSetup = first.provider.watch('/remote/repo', vi.fn())
      first.settleWatch()
      const { onEvents, onTerminalError, controller } = install(first.provider, await initialSetup)
      first.mux.dispose('connection_lost')
      first.provider.dispose()
      const next = connect()
      registerProvider(next.provider)
      await vi.waitFor(() => expect(next.countRequests('fs.watch')).toBe(1))
      next.mux.dispose('connection_lost')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(getProvider('ssh-1')).toBe(next.provider)
      expect(onTerminalError).not.toHaveBeenCalled()
      expect(controller.signal.aborted).toBe(false)
      expect(onEvents).not.toHaveBeenCalled()
      if (owner === 'canceled') {
        await unsubscribe?.()
      }

      next.provider.dispose()
      const current = connect()
      registerProvider(current.provider)
      if (owner === 'canceled') {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(current.countRequests('fs.watch')).toBe(0)
        return
      }
      await vi.waitFor(() => expect(current.countRequests('fs.watch')).toBe(1))
      current.settleWatch()
      await vi.waitFor(() =>
        expect(onEvents).toHaveBeenCalledExactlyOnceWith([
          { kind: 'overflow', absolutePath: '/remote/repo' }
        ])
      )
      current.emitChange()
      expect(onEvents).toHaveBeenLastCalledWith([
        { kind: 'update', absolutePath: '/remote/repo/current.ts' }
      ])
      await unsubscribe?.()
      expect(current.countRequests('fs.unwatch')).toBe(1)
      current.emitChange()
      expect(onEvents).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['unregistered', 'replaced'] as const)(
    'ignores a setup failure when its provider is %s between rejection handlers',
    async (change) => {
      const { onTerminalError, onEvents, controller } = install()
      const old = pendingWatch()
      registerProvider(old)
      await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
      const current = { watch: vi.fn(async () => vi.fn()) }
      const checkedWhileCurrent = vi.fn(() => {
        queueMicrotask(() => {
          if (change === 'replaced') {
            registerProvider(current)
          } else {
            getProvider.mockReturnValue(undefined)
          }
        })
        return old
      })
      getProvider.mockImplementationOnce(checkedWhileCurrent)
      old.reject(new Error('previous setup failed'))
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(checkedWhileCurrent).toHaveBeenCalledOnce()
      expect(onTerminalError).not.toHaveBeenCalled()
      expect(controller.signal.aborted).toBe(false)
      if (change === 'replaced') {
        expect(current.watch).toHaveBeenCalledOnce()
        expect(onEvents).toHaveBeenCalledExactlyOnceWith([
          { kind: 'overflow', absolutePath: '/remote/repo' }
        ])
      } else {
        expect(onEvents).not.toHaveBeenCalled()
      }
    }
  )

  it('ignores late terminal callbacks from a superseded provider', async () => {
    const { onTerminalError, controller } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
    const current = { watch: vi.fn(async () => vi.fn()) }
    registerProvider(current)
    old.watch.mock.calls[0]?.[2]?.onTerminalError?.(new Error('previous watcher stopped'))
    old.resolve(vi.fn())

    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
  })

  it('reports a terminal callback from the current provider', async () => {
    const { onTerminalError, onEvents } = install()
    const current = pendingWatch()
    registerProvider(current)
    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    current.resolve(vi.fn())
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    const error = new Error('current watcher stopped')
    current.watch.mock.calls[0]?.[2]?.onTerminalError?.(error)

    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('ignores late events from a superseded provider and delivers current events', async () => {
    const { onEvents } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
    const current = pendingWatch()
    registerProvider(current)
    old.watch.mock.calls[0]?.[1]([{ kind: 'update', absolutePath: '/remote/repo/old.ts' }])
    old.resolve(vi.fn())
    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    current.resolve(vi.fn())
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    const currentEvents = [{ kind: 'update' as const, absolutePath: '/remote/repo/current.ts' }]
    current.watch.mock.calls[0]?.[1](currentEvents)

    expect(onEvents).toHaveBeenCalledTimes(2)
    expect(onEvents).toHaveBeenLastCalledWith(currentEvents)
  })

  it('releases the previous subscriber when the same provider is registered again', async () => {
    const { onEvents } = install()
    const callbacks = new Set<Parameters<IFilesystemProvider['watch']>[1]>()
    const provider = {
      watch: vi.fn<IFilesystemProvider['watch']>(async (_root, callback) => {
        callbacks.add(callback)
        return () => {
          callbacks.delete(callback)
        }
      })
    }
    registerProvider(provider)
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    registerProvider(provider)
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledTimes(2))

    expect(callbacks.size).toBe(1)
    const events = [{ kind: 'update' as const, absolutePath: '/remote/repo/current.ts' }]
    for (const callback of callbacks) {
      callback(events)
    }
    expect(onEvents).toHaveBeenCalledTimes(3)
    expect(onEvents).toHaveBeenLastCalledWith(events)
    await unsubscribe?.()
    expect(callbacks.size).toBe(0)
  })

  it('does not report a setup failure after unsubscribe starts', async () => {
    const { onTerminalError, onEvents, initialUnwatch } = install()
    const pending = pendingWatch()
    registerProvider(pending)
    await vi.waitFor(() => expect(pending.watch).toHaveBeenCalledOnce())
    const closed = unsubscribe?.()
    pending.reject(new Error('setup canceled during shutdown'))

    await closed
    expect(initialUnwatch).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(onEvents).not.toHaveBeenCalled()
  })

  it('closes a replacement that finishes after unsubscribe starts', async () => {
    const { onTerminalError, onEvents } = install()
    const pending = pendingWatch()
    registerProvider(pending)
    await vi.waitFor(() => expect(pending.watch).toHaveBeenCalledOnce())
    const closed = unsubscribe?.()
    const lateUnwatch = vi.fn()
    pending.resolve(lateUnwatch)

    await closed
    expect(lateUnwatch).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(onEvents).not.toHaveBeenCalled()
  })
})
