import { describe, expect, it, vi } from 'vitest'

import { BrowserClientHostAuthorityReplacementWait } from './browser-client-host-authority-replacement-wait'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
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
  pairingAuthorityConnectionIdentity: 'pairing-authority-record-a',
  legacyAuthorityConnectionIdentity: 'legacy-authority-record-a'
}
const replacementInput = {
  authorityConnectionIdentity: 'authority-record-b',
  pairingAuthorityConnectionIdentity: 'pairing-authority-record-b',
  legacyAuthorityConnectionIdentity: 'legacy-authority-record-b'
}

describe('PairedRuntimeBrowserClientHostComposition', () => {
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
    hostsPage: vi.fn(() => false),
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
