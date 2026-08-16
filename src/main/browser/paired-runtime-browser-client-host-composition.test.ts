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

    expect(rig.order).toEqual(['activate-routes', 'close-host', 'close-executor', 'close-routes'])
  })

  it('fails closed without racing page cleanup when handlers do not settle', async () => {
    const rig = createRig({ hostSettled: false })
    const composition = rig.createComposition()
    await composition.start()

    await expect(composition.close()).resolves.toBe(false)

    expect(rig.order).toEqual(['activate-routes', 'close-host', 'close-routes'])
    expect(rig.executor.close).not.toHaveBeenCalled()

    rig.settleHandlers()
    await composition.whenClosed()

    expect(rig.order).toEqual(['activate-routes', 'close-host', 'close-routes', 'close-executor'])
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
