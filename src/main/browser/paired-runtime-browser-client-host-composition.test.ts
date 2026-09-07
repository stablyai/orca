import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BrowserClientHostAuthorityReplacementWait } from './browser-client-host-authority-replacement-wait'
import { BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE } from '../../shared/browser-client-host-protocol'
import { PairedRuntimeBrowserClientHostComposition } from './paired-runtime-browser-client-host-composition'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 4,
  pageCommandProtocolVersion: 1
}

const replacementAuthority: BrowserClientHostLeaseAuthority = {
  ...authority,
  authorityRuntimeId: 'runtime-b',
  authorityEpoch: 'epoch-b',
  browserHostGeneration: 1,
  pageInventoryProtocolVersion: 1,
  pageReconciliationProtocolVersion: 1
}

const initialInput = {
  authorityConnectionIdentity: 'authority-record-a',
  legacyAuthorityConnectionIdentity: 'legacy-authority-record-a'
}
const replacementInput = {
  authorityConnectionIdentity: 'authority-record-b',
  legacyAuthorityConnectionIdentity: 'legacy-authority-record-b'
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

  it('publishes a fresh inventory snapshot for every reconnect attach', () => {
    const rig = createRig({ pageInventory: [] })
    rig.executor.snapshotPageInventory
      .mockReturnValueOnce([])
      .mockReturnValueOnce([retainedPageInventory()])
    rig.createComposition()

    expect(rig.hostOptions.getPageInventory?.()).toEqual([])
    expect(rig.hostOptions.getPageInventory?.()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'active' })
    ])
    expect(rig.executor.snapshotPageInventory).toHaveBeenCalledTimes(2)
  })

  it('coalesces page availability losses into one inventory refresh', async () => {
    const rig = createRig()
    rig.createComposition()

    rig.reportPageUnavailable()
    rig.reportPageUnavailable()

    expect(rig.host.refreshPageInventory).toHaveBeenCalledOnce()
    await Promise.resolve()
    await Promise.resolve()
    rig.reportPageUnavailable()
    expect(rig.host.refreshPageInventory).toHaveBeenCalledTimes(2)
  })

  it('preserves inventory while replacing authority with fresh routes', async () => {
    const rig = createRig()
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.replaceAuthority(replacementInput)).resolves.toEqual(
      replacementAuthority
    )

    expect(rig.replacementInventory).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', authorityRuntimeId: 'runtime-a' })
    ])
    expect(rig.executor.close).not.toHaveBeenCalled()
    expect(rig.routes.close).not.toHaveBeenCalled()
    expect(rig.order).toEqual([
      'activate-routes',
      'retire-routes',
      'fence-authority-transition',
      'close-host',
      'complete-authority-transition',
      'attach-replacement-inventory',
      'activate-replacement-routes'
    ])
  })

  it('rejects retained inventory when replacement cannot reconcile it', async () => {
    const rig = createRig({
      replacementAuthority: {
        ...replacementAuthority,
        pageInventoryProtocolVersion: undefined,
        pageReconciliationProtocolVersion: undefined
      }
    })
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.replaceAuthority(replacementInput)).rejects.toThrow(
      'browser_client_page_reconciliation_unsupported'
    )

    expect(rig.replacementInventory).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', authorityRuntimeId: 'runtime-a' })
    ])
    expect(rig.replacementRoutes.close).not.toHaveBeenCalled()
    expect(rig.order).not.toContain('activate-replacement-routes')
    await composition.close()
  })

  it('allows a legacy replacement when there is no retained inventory', async () => {
    const legacyAuthority = {
      ...replacementAuthority,
      pageInventoryProtocolVersion: undefined,
      pageReconciliationProtocolVersion: undefined
    }
    const rig = createRig({ pageInventory: [], replacementAuthority: legacyAuthority })
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.replaceAuthority(replacementInput)).resolves.toEqual(legacyAuthority)

    expect(rig.replacementInventory).toEqual([])
    expect(rig.order).toContain('activate-replacement-routes')
    await composition.close()
  })

  it('waits for old handlers and ignores their late callbacks before replacement', async () => {
    const rig = createRig({ hostSettled: false })
    const composition = rig.createComposition()
    await composition.start()
    const oldCallbacks = rig.hostOptionsHistory[0]!

    const replacing = composition.replaceAuthority(replacementInput)
    await Promise.resolve()
    expect(rig.hosts).toHaveLength(1)

    rig.settleHandlers()
    await replacing
    oldCallbacks.onError?.(new Error('late old-host failure'))
    oldCallbacks.onTransportLost?.(new Error('late old-host loss'))

    expect(rig.hosts).toHaveLength(2)
    expect(rig.hosts[1]!.close).not.toHaveBeenCalled()
    expect(rig.replacementRoutes.suspend).not.toHaveBeenCalled()
    expect(rig.onError).not.toHaveBeenCalled()
  })

  it('fails closed when retired routes reject during replacement', async () => {
    const routeRetireError = new Error('route retirement failed')
    const rig = createRig({ routeRetireError })
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.replaceAuthority(replacementInput)).rejects.toThrow(
      'paired_runtime_browser_client_host_composition_closed'
    )
    await composition.whenClosed()

    expect(rig.onError).toHaveBeenCalledWith(routeRetireError)
    expect(rig.executor.close).toHaveBeenCalledOnce()
    expect(rig.routes.close).toHaveBeenCalledOnce()
    expect(rig.order).not.toContain('activate-replacement-routes')
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
      'closing',
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
    expect(rig.order.slice(0, 5)).toEqual([
      'activate-routes',
      'closing',
      'suspend-routes',
      'fence-navigation',
      'close-host'
    ])
    await composition.whenClosed()
  })

  it('waits out the grace instead of tearing down when the authority was replaced', async () => {
    vi.useFakeTimers()
    try {
      const rig = createRig()
      const composition = rig.createComposition()
      await composition.start()

      rig.hostOptions.onError?.(authorityReplacedError())

      // The guests are alive and still ours; the replacement runtime is on its way to reclaim them.
      expect(rig.authorityReplacementWait.armed).toBe(true)
      expect(rig.onError).not.toHaveBeenCalled()
      expect(rig.order).toEqual(['activate-routes'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('tears the composition down once the grace expires with no replacement', async () => {
    vi.useFakeTimers()
    try {
      const rig = createRig()
      const composition = rig.createComposition()
      await composition.start()
      const replaced = authorityReplacedError()

      rig.hostOptions.onError?.(replaced)
      vi.advanceTimersByTime(1_000)

      expect(rig.onError).toHaveBeenCalledWith(replaced)
      expect(rig.order).toContain('closing')
      await vi.runAllTimersAsync()
      await composition.whenClosed()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the grace when the replacement authority actually arrives', async () => {
    vi.useFakeTimers()
    try {
      const rig = createRig()
      const composition = rig.createComposition()
      await composition.start()
      rig.hostOptions.onError?.(authorityReplacedError())

      await composition.replaceAuthority(replacementInput)

      // Released at the transition, not merely ignored when it fires: a deadline left running holds
      // a timer for the whole grace and fires against a composition that has already moved on.
      expect(rig.authorityReplacementWait.armed).toBe(false)
      vi.advanceTimersByTime(10_000)
      expect(rig.onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the grace when the composition closes for another reason', async () => {
    vi.useFakeTimers()
    try {
      const rig = createRig()
      const composition = rig.createComposition()
      await composition.start()
      rig.hostOptions.onError?.(authorityReplacedError())

      await composition.close()

      expect(rig.authorityReplacementWait.armed).toBe(false)
      vi.advanceTimersByTime(10_000)
      // A grace that fired after close would report a second, bogus failure for a dead composition.
      expect(rig.onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms one deadline for a burst of mismatch errors', async () => {
    vi.useFakeTimers()
    try {
      const rig = createRig()
      const composition = rig.createComposition()
      await composition.start()

      rig.hostOptions.onError?.(authorityReplacedError())
      vi.advanceTimersByTime(900)
      rig.hostOptions.onError?.(authorityReplacedError())
      vi.advanceTimersByTime(100)

      expect(rig.onError).toHaveBeenCalledTimes(1)
      await vi.runAllTimersAsync()
      await composition.whenClosed()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still tears down immediately for a host error that is not a replacement', async () => {
    vi.useFakeTimers()
    try {
      const rig = createRig()
      const composition = rig.createComposition()
      await composition.start()
      const fatal = new Error('browser host process exited')

      rig.hostOptions.onError?.(fatal)

      expect(rig.authorityReplacementWait.armed).toBe(false)
      expect(rig.onError).toHaveBeenCalledWith(fatal)
      await vi.runAllTimersAsync()
      await composition.whenClosed()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed without racing page cleanup when handlers do not settle', async () => {
    const rig = createRig({ hostSettled: false })
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.close()).resolves.toBe(false)

    expect(rig.order).toEqual([
      'activate-routes',
      'closing',
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
      'closing',
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

function createRig(
  options: {
    executorCloseError?: Error
    hostSettled?: boolean
    pageInventory?: readonly BrowserClientHostedPageInventory[]
    replacementAuthority?: BrowserClientHostLeaseAuthority
    routeRetireError?: Error
    authorityReplacementGraceMs?: number
  } = {}
) {
  const authorityReplacementWait = new BrowserClientHostAuthorityReplacementWait(
    options.authorityReplacementGraceMs ?? 1_000
  )
  const order: string[] = []
  let onPageUnavailable = (_browserPageId: string, _pageHostGeneration: number): void => {}
  let settleHandlers = (): void => {}
  const handlersSettled = new Promise<void>((resolve) => {
    settleHandlers = resolve
  })
  const createRoutes = (replacement = false) => ({
    retain: vi.fn(),
    suspend: vi.fn(() => {
      order.push(replacement ? 'suspend-replacement-routes' : 'suspend-routes')
    }),
    reconnect: vi.fn(async () => {}),
    retire: vi.fn(async () => {
      order.push(replacement ? 'retire-replacement-routes' : 'retire-routes')
      if (!replacement && options.routeRetireError) {
        throw options.routeRetireError
      }
    }),
    close: vi.fn(async () => {
      order.push(replacement ? 'close-replacement-routes' : 'close-routes')
    })
  })
  const routes = createRoutes()
  const replacementRoutes = createRoutes(true)
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
    beginAuthorityTransition: vi.fn(() => {
      order.push('fence-authority-transition')
    }),
    completeAuthorityTransition: vi.fn(() => {
      order.push('complete-authority-transition')
    }),
    fenceNavigation: vi.fn(() => {
      order.push('fence-navigation')
    }),
    snapshotPageInventory: vi.fn(() => options.pageInventory ?? [retainedPageInventory()]),
    close: vi.fn(async () => {
      order.push('close-executor')
      if (options.executorCloseError) {
        throw options.executorCloseError
      }
    })
  }
  type HostOptions = {
    getPageInventory?: () => readonly unknown[]
    onAuthority?: (next: BrowserClientHostLeaseAuthority) => void
    onTransportLost?: (error: Error) => void
    onReconnected?: (next: BrowserClientHostLeaseAuthority) => void
    onError?: (error: Error) => void
    handler?: (
      event: BrowserClientHostCommandEvent,
      signal: AbortSignal
    ) => Promise<{ status: 'completed' | 'failed'; errorCode?: string }>
  }
  const hostOptionsHistory: HostOptions[] = []
  const hosts: {
    start: ReturnType<typeof vi.fn>
    retirePage: ReturnType<typeof vi.fn>
    forgetPage: ReturnType<typeof vi.fn>
    whenHandlersSettled: ReturnType<typeof vi.fn>
    refreshPageInventory: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }[] = []
  let replacementInventory: readonly unknown[] = []
  const makeHost = (callbacks: HostOptions, replacement: boolean) => ({
    start: vi.fn(async () => {
      const nextAuthority = replacement
        ? (options.replacementAuthority ?? replacementAuthority)
        : authority
      if (replacement) {
        replacementInventory = callbacks.getPageInventory?.() ?? []
        order.push('attach-replacement-inventory')
      }
      callbacks.onAuthority?.(nextAuthority)
      return nextAuthority
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
    refreshPageInventory: vi.fn(async () => {}),
    close: vi.fn(async () => {
      order.push(replacement ? 'close-replacement-host' : 'close-host')
      return replacement ? true : (options.hostSettled ?? true)
    })
  })
  const onError = vi.fn()
  return {
    order,
    authorityReplacementWait,
    routes,
    replacementRoutes,
    executor,
    hosts,
    hostOptionsHistory,
    onError,
    reportPageUnavailable: () => onPageUnavailable('page-a', 7),
    settleHandlers,
    get hostOptions() {
      return hostOptionsHistory.at(-1) ?? {}
    },
    get host() {
      return hosts[0]!
    },
    get replacementInventory() {
      return replacementInventory
    },
    createComposition: () =>
      new PairedRuntimeBrowserClientHostComposition({
        initialInput,
        createRoutes: (input, nextAuthority) => {
          const replacement = input === replacementInput
          expect(nextAuthority).toEqual(
            replacement ? (options.replacementAuthority ?? replacementAuthority) : authority
          )
          order.push(replacement ? 'activate-replacement-routes' : 'activate-routes')
          return replacement ? replacementRoutes : routes
        },
        createExecutor: (_input, executorOptions) => {
          onPageUnavailable = executorOptions.onPageUnavailable
          return executor
        },
        createHost: (input, callbacks) => {
          const replacement = input === replacementInput
          hostOptionsHistory.push(callbacks)
          const host = makeHost(callbacks, replacement)
          hosts.push(host)
          return host
        },
        onClosing: () => {
          order.push('closing')
        },
        createAuthorityReplacementWait: () => authorityReplacementWait,
        onError
      })
  }
}

function authorityReplacedError(): Error {
  return Object.assign(new Error('lease attach named a retired runtime'), {
    code: BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE
  })
}

function retainedPageInventory(): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 4,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    browserProfileId: 'profile-a',
    executionHostKey: 'execution-host-a',
    state: 'active'
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
