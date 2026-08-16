import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { PairedRuntimeBrowserClientHostComposition } from './paired-runtime-browser-client-host-composition'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 4,
  pageCommandProtocolVersion: 1
}

describe('PairedRuntimeBrowserClientHostComposition', () => {
  it('activates exact route authority before admitting page commands', async () => {
    const rig = createRig()
    const composition = rig.createComposition()

    await expect(composition.start()).resolves.toEqual(authority)
    await rig.hostOptions.handler?.(command(), new AbortController().signal)

    expect(rig.order).toEqual(['activate-routes', 'handle-command'])
  })

  it('provides the exact executor inventory to the host attach', () => {
    const rig = createRig()
    rig.createComposition()

    expect(rig.hostOptions.getPageInventory?.()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'active' })
    ])
    expect(rig.executor.snapshotPageInventory).toHaveBeenCalledOnce()
  })

  it('suspends routes without closing pages and gates commands through recovery', async () => {
    const rig = createRig()
    const composition = rig.createComposition()
    await composition.start()

    rig.hostOptions.onTransportLost?.(new Error('transport lost'))
    const handling = rig.hostOptions.handler?.(command(), new AbortController().signal)
    await Promise.resolve()
    expect(rig.routes.suspend).toHaveBeenCalledOnce()
    expect(rig.executor.handle).not.toHaveBeenCalled()
    expect(rig.executor.close).not.toHaveBeenCalled()

    rig.hostOptions.onReconnected?.(authority)
    await expect(handling).resolves.toEqual({ status: 'completed' })
    expect(rig.routes.reconnect).toHaveBeenCalledOnce()
    expect(rig.executor.handle).toHaveBeenCalledOnce()
  })

  it('keeps one command gate across repeated loss while fencing stale route recovery', async () => {
    const firstRecovery = deferred<void>()
    const secondRecovery = deferred<void>()
    const rig = createRig()
    rig.routes.reconnect
      .mockImplementationOnce(() => firstRecovery.promise)
      .mockImplementationOnce(() => secondRecovery.promise)
    const composition = rig.createComposition()
    await composition.start()

    rig.hostOptions.onTransportLost?.(new Error('first loss'))
    const handling = rig.hostOptions.handler?.(command(), new AbortController().signal)
    rig.hostOptions.onReconnected?.(authority)
    rig.hostOptions.onTransportLost?.(new Error('second loss'))
    rig.hostOptions.onReconnected?.(authority)
    firstRecovery.reject(new Error('superseded route recovery'))
    await Promise.resolve()

    expect(rig.host.close).not.toHaveBeenCalled()
    expect(rig.executor.handle).not.toHaveBeenCalled()
    secondRecovery.resolve()
    await expect(handling).resolves.toEqual({ status: 'completed' })
    expect(rig.routes.suspend).toHaveBeenCalledTimes(2)
    expect(rig.routes.reconnect).toHaveBeenCalledTimes(2)
    expect(rig.executor.handle).toHaveBeenCalledOnce()
  })

  it('settles dispatcher retirement before destroying and forgetting the page', async () => {
    const rig = createRig()
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.retirePage('page-a', 7)).resolves.toBe(true)

    expect(rig.order).toEqual([
      'activate-routes',
      'retire-dispatcher-page',
      'retire-executor-page',
      'forget-dispatcher-page'
    ])
  })

  it('closes control transport before executor pages and routes', async () => {
    const rig = createRig()
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.close()).resolves.toBe(true)

    expect(rig.order).toEqual([
      'activate-routes',
      'suspend-routes',
      'fence-navigation',
      'close-host',
      'close-executor',
      'close-routes'
    ])
  })

  it('fences navigation and routes before terminal host cleanup can wait', async () => {
    const rig = createRig()
    const composition = rig.createComposition()
    const error = new Error('terminal authority loss')
    await composition.start()

    rig.hostOptions.onError?.(error)

    expect(rig.routes.suspend).toHaveBeenCalledWith(error)
    expect(rig.executor.fenceNavigation).toHaveBeenCalledOnce()
    expect(rig.order.slice(0, 4)).toEqual([
      'activate-routes',
      'suspend-routes',
      'fence-navigation',
      'close-host'
    ])
    await composition.whenClosed()
  })

  it('fails closed without racing page cleanup when handlers do not settle', async () => {
    const rig = createRig({ hostSettled: false })
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.close()).resolves.toBe(false)

    expect(rig.order).toEqual([
      'activate-routes',
      'suspend-routes',
      'fence-navigation',
      'close-host',
      'close-routes'
    ])
    expect(rig.executor.close).not.toHaveBeenCalled()

    rig.settleHandlers()
    await composition.whenClosed()

    expect(rig.order).toEqual([
      'activate-routes',
      'suspend-routes',
      'fence-navigation',
      'close-host',
      'close-routes',
      'close-executor'
    ])
  })

  it('reports a deferred executor cleanup failure while retaining its fence', async () => {
    const cleanupError = new Error('executor cleanup failed')
    const rig = createRig({ executorCloseError: cleanupError, hostSettled: false })
    const composition = rig.createComposition()
    await composition.start()
    await composition.close()

    rig.settleHandlers()

    await expect(composition.whenClosed()).rejects.toThrow('executor cleanup failed')
    expect(rig.onError).toHaveBeenCalledWith(cleanupError)
  })

  it('forgets a failed create that left no unresolved executor page', async () => {
    const rig = createRig()
    rig.executor.retirePage.mockResolvedValueOnce(false)
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.retirePage('page-a', 7)).resolves.toBe(true)

    expect(rig.executor.hasUnresolvedPage).toHaveBeenCalledWith('page-a', 7)
    expect(rig.host.forgetPage).toHaveBeenCalledWith('page-a', 7)
  })

  it('keeps an unresolved failed create fenced', async () => {
    const rig = createRig()
    rig.executor.retirePage.mockResolvedValueOnce(false)
    rig.executor.hasUnresolvedPage.mockReturnValueOnce(true)
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.retirePage('page-a', 7)).rejects.toThrow(
      'browser_client_page_retirement_cleanup_pending'
    )

    expect(rig.host.forgetPage).not.toHaveBeenCalled()
  })
})

function createRig(options: { executorCloseError?: Error; hostSettled?: boolean } = {}) {
  const order: string[] = []
  let settleHandlers = (): void => {}
  const handlersSettled = new Promise<void>((resolve) => {
    settleHandlers = resolve
  })
  const routes = {
    retain: vi.fn(),
    suspend: vi.fn(() => {
      order.push('suspend-routes')
    }),
    reconnect: vi.fn(async () => {}),
    close: vi.fn(async () => {
      order.push('close-routes')
    })
  }
  const executor = {
    handle: vi.fn(async () => {
      order.push('handle-command')
      return { status: 'completed' as const }
    }),
    retirePage: vi.fn(async () => {
      order.push('retire-executor-page')
      return true
    }),
    hasUnresolvedPage: vi.fn(() => false),
    fenceNavigation: vi.fn(() => {
      order.push('fence-navigation')
    }),
    snapshotPageInventory: vi.fn(() => [
      {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'client-a',
        browserHostGeneration: 4,
        browserPageId: 'page-a',
        pageHostGeneration: 7,
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-host-a',
        state: 'active' as const
      }
    ]),
    close: vi.fn(async () => {
      order.push('close-executor')
      if (options.executorCloseError) {
        throw options.executorCloseError
      }
    })
  }
  let hostOptions: {
    getPageInventory?: () => readonly unknown[]
    onAuthority?: (next: BrowserClientHostLeaseAuthority) => void
    onTransportLost?: (error: Error) => void
    onReconnected?: (next: BrowserClientHostLeaseAuthority) => void
    onError?: (error: Error) => void
    handler?: (
      event: BrowserClientHostCommandEvent,
      signal: AbortSignal
    ) => Promise<{ status: 'completed' | 'failed'; errorCode?: string }>
  } = {}
  const host = {
    start: vi.fn(async () => {
      hostOptions.onAuthority?.(authority)
      return authority
    }),
    retirePage: vi.fn(async () => {
      order.push('retire-dispatcher-page')
      return true
    }),
    forgetPage: vi.fn(() => {
      order.push('forget-dispatcher-page')
      return true
    }),
    whenHandlersSettled: vi.fn(() => handlersSettled),
    close: vi.fn(async () => {
      order.push('close-host')
      return options.hostSettled ?? true
    })
  }
  const onError = vi.fn()
  return {
    order,
    routes,
    executor,
    host,
    onError,
    settleHandlers,
    get hostOptions() {
      return hostOptions
    },
    createComposition: () =>
      new PairedRuntimeBrowserClientHostComposition({
        createRoutes: (next) => {
          expect(next).toEqual(authority)
          order.push('activate-routes')
          return routes
        },
        createExecutor: () => executor,
        createHost: (next) => {
          hostOptions = next
          return host
        },
        onError
      })
  }
}

function command(): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    ...authority,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    commandSequence: 1,
    commandId: 'command-a',
    command: {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'execution-host-a'
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve = (_value: T): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}
