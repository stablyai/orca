import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`

function createCommand(
  type: 'createPage' | 'navigate',
  overrides: Partial<BrowserClientHostCommandEvent> = {}
): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 3,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    commandSequence: type === 'createPage' ? 1 : 2,
    commandId: `${type}-a`,
    command:
      type === 'createPage'
        ? {
            type: 'createPage',
            browserProfileId: 'profile-a',
            executionHostKey: 'execution-host-a'
          }
        : { type: 'navigate', url: 'example.internal/path' },
    ...overrides
  } as BrowserClientHostCommandEvent
}

function createLifecycleClaim(
  registration: BrowserRoutePageGuestIdentity,
  whenDestroyed: Promise<void> = Promise.resolve()
): BrowserRouteGuestLifecycleClaim {
  return {
    registration: { ...registration },
    guestAuthority: Symbol('guest-authority'),
    whenDestroyed
  }
}

function createHarness(options: { maxPages?: number } = {}) {
  const order: string[] = []
  let rendererCurrent = true
  const route = {
    key: 'execution-host-a',
    executionHostIdentity: 'execution-host-record-a',
    proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
    release: vi.fn(async () => {
      order.push('release-route')
    })
  }
  const routeSession = {
    partition,
    release: vi.fn(() => {
      order.push('release-session')
    })
  }
  const renderer = {
    rendererWebContentsId: 11,
    isCurrent: vi.fn(() => rendererCurrent),
    mountPage: vi.fn(async () => {
      order.push('mount-page')
      return { webContentsId: 41 }
    }),
    retirePage: vi.fn(async () => {
      order.push('retire-renderer-page')
    })
  }
  const dependencies = {
    orcaProfileId: 'orca-profile-a',
    authorityConnectionIdentity: 'authority-record-a',
    maxPages: options.maxPages,
    retainNetworkRoute: vi.fn(async () => {
      order.push('retain-route')
      return route
    }),
    selectRenderer: vi.fn(() => renderer),
    routeSessions: {
      preparePage: vi.fn(async () => {
        order.push('prepare-page')
        return routeSession
      })
    },
    routeWebContents: {
      claimGuestLifecycle: vi.fn((registration: BrowserRoutePageGuestIdentity) => {
        order.push('claim-guest')
        return createLifecycleClaim(registration)
      }),
      registerGuest: vi.fn(() => {
        order.push('register-guest')
        return true
      }),
      grantNavigation: vi.fn(() => {
        order.push('grant-navigation')
        return true
      }),
      navigateGuest: vi.fn(async () => {
        order.push('navigate-guest')
        return true
      }),
      beginGuestRetirement: vi.fn(() => {
        order.push('retire-guest')
        return Promise.resolve()
      })
    }
  }
  return {
    dependencies,
    executor: new BrowserClientPageCommandExecutor(dependencies),
    order,
    renderer,
    route,
    routeSession,
    setRendererCurrent: (value: boolean) => {
      rendererCurrent = value
    }
  }
}

describe('BrowserClientPageCommandExecutor', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('prepares the exact route and blank guest before granting navigation', async () => {
    const { dependencies, executor, order, renderer } = createHarness()
    const command = createCommand('createPage')

    await expect(executor.handle(command, new AbortController().signal)).resolves.toEqual({
      status: 'completed'
    })

    expect(order).toEqual([
      'retain-route',
      'prepare-page',
      'mount-page',
      'claim-guest',
      'register-guest',
      'grant-navigation'
    ])
    expect(dependencies.retainNetworkRoute).toHaveBeenCalledWith(
      'execution-host-a',
      expect.any(AbortSignal)
    )
    expect(dependencies.routeSessions.preparePage).toHaveBeenCalledWith({
      identity: {
        orcaProfileId: 'orca-profile-a',
        browserProfileId: 'profile-a',
        authorityConnectionIdentity: 'authority-record-a',
        executionHostIdentity: 'execution-host-record-a'
      },
      browserPageId: 'page-a',
      pageHostGeneration: 7,
      rendererWebContentsId: 11,
      proxyEndpoint: { host: '127.0.0.1', port: 43123 }
    })
    expect(renderer.mountPage).toHaveBeenCalledWith(
      {
        partition,
        browserPageId: 'page-a',
        pageHostGeneration: 7
      },
      expect.any(AbortSignal)
    )
    expect(dependencies.routeWebContents.registerGuest).toHaveBeenCalledWith({
      partition,
      browserPageId: 'page-a',
      pageHostGeneration: 7,
      rendererWebContentsId: 11,
      webContentsId: 41
    })
  })

  it('loads a normalized URL only through the retained exact guest', async () => {
    const { dependencies, executor } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    const lifecycleClaim = dependencies.routeWebContents.claimGuestLifecycle.mock.results[0]?.value

    await expect(
      executor.handle(createCommand('navigate'), new AbortController().signal)
    ).resolves.toEqual({ status: 'completed' })

    expect(dependencies.routeWebContents.navigateGuest).toHaveBeenCalledWith(
      lifecycleClaim,
      'https://example.internal/path'
    )
  })

  it('rejects stale generations and local-file navigation without touching Chromium', async () => {
    const { dependencies, executor } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    const stale = createCommand('navigate', { pageHostGeneration: 8 })
    await expect(executor.handle(stale, new AbortController().signal)).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_generation_stale'
    })
    const localFile = createCommand('navigate', {
      command: { type: 'navigate', url: 'file:///etc/passwd' }
    })
    await expect(executor.handle(localFile, new AbortController().signal)).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_navigation_invalid'
    })
    expect(dependencies.routeWebContents.navigateGuest).not.toHaveBeenCalled()
  })

  it('releases every exact resource when guest registration fails', async () => {
    const { dependencies, executor, order } = createHarness()
    dependencies.routeWebContents.registerGuest.mockImplementationOnce(() => {
      order.push('register-guest')
      return false
    })

    await expect(
      executor.handle(createCommand('createPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_guest_registration_failed'
    })

    expect(order).toEqual([
      'retain-route',
      'prepare-page',
      'mount-page',
      'claim-guest',
      'register-guest',
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
    expect(executor.hasPage('page-a', 7)).toBe(false)
  })

  it('holds network resources when guest retirement cannot be confirmed', async () => {
    const { dependencies, executor, order, route, routeSession } = createHarness()
    dependencies.routeWebContents.registerGuest.mockImplementationOnce(() => {
      order.push('register-guest')
      return false
    })
    dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce((registration) => {
      order.push('claim-guest')
      return createLifecycleClaim(
        registration,
        Promise.reject(new Error('guest destruction unavailable'))
      )
    })
    dependencies.routeWebContents.beginGuestRetirement.mockImplementationOnce(() => {
      order.push('retire-guest')
      throw new Error('guest cleanup failed')
    })

    await expect(
      executor.handle(createCommand('createPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_cleanup_failed'
    })
    expect(order.slice(-2)).toEqual(['retire-guest', 'retire-renderer-page'])
    expect(routeSession.release).not.toHaveBeenCalled()
    expect(route.release).not.toHaveBeenCalled()
    expect(executor.hasUnresolvedPage('page-a', 7)).toBe(true)
    await expect(
      executor.handle(
        createCommand('createPage', { pageHostGeneration: 8 }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_generation_conflict'
    })
  })

  it('holds network resources when a failed mount may have created a guest', async () => {
    const { executor, order, renderer, route, routeSession } = createHarness()
    renderer.mountPage.mockImplementationOnce(async () => {
      order.push('mount-page')
      throw new Error('mount outcome unknown')
    })
    await expect(
      executor.handle(createCommand('createPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_cleanup_failed'
    })
    expect(order.slice(-2)).toEqual(['mount-page', 'retire-renderer-page'])
    expect(routeSession.release).not.toHaveBeenCalled()
    expect(route.release).not.toHaveBeenCalled()
    await expect(
      executor.handle(
        createCommand('createPage', { pageHostGeneration: 8 }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_generation_conflict'
    })
  })

  it('fails closed if the selected renderer is replaced during creation', async () => {
    const { dependencies, executor, renderer, setRendererCurrent } = createHarness()
    renderer.mountPage.mockImplementationOnce(async () => {
      setRendererCurrent(false)
      return { webContentsId: 41 }
    })

    await expect(
      executor.handle(createCommand('createPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_renderer_stale'
    })
    expect(dependencies.routeWebContents.registerGuest).not.toHaveBeenCalled()
    expect(dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledOnce()
    expect(renderer.retirePage).toHaveBeenCalledOnce()
    expect(executor.hasUnresolvedPage('page-a', 7)).toBe(false)
  })

  it('cleans up an exact mounted guest when creation is aborted', async () => {
    const { dependencies, executor, renderer } = createHarness()
    const controller = new AbortController()
    renderer.mountPage.mockImplementationOnce(async () => {
      controller.abort()
      return { webContentsId: 41 }
    })

    await expect(executor.handle(createCommand('createPage'), controller.signal)).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_command_aborted'
    })
    expect(dependencies.routeWebContents.registerGuest).not.toHaveBeenCalled()
    expect(dependencies.routeWebContents.beginGuestRetirement).toHaveBeenCalledOnce()
    expect(renderer.retirePage).toHaveBeenCalledOnce()
  })

  it('retires only the exact generation before admitting its replacement', async () => {
    const { executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    await expect(executor.retirePage('page-a', 8)).resolves.toBe(false)
    expect(executor.hasPage('page-a', 7)).toBe(true)
    await expect(executor.retirePage('page-a', 7)).resolves.toBe(true)
    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])

    const replacement = createCommand('createPage', { pageHostGeneration: 8 })
    await expect(executor.handle(replacement, new AbortController().signal)).resolves.toEqual({
      status: 'completed'
    })
  })

  it('holds Session and route release for the exact destroyed acknowledgement', async () => {
    const { dependencies, executor, order } = createHarness()
    let acknowledgeDestroyed = (): void => {}
    const destroyed = new Promise<void>((resolve) => {
      acknowledgeDestroyed = resolve
    })
    dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce((registration) => {
      order.push('claim-guest')
      return createLifecycleClaim(registration, destroyed)
    })
    dependencies.routeWebContents.beginGuestRetirement.mockImplementationOnce(() => {
      order.push('retire-guest')
      return destroyed
    })
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    const retiring = executor.retirePage('page-a', 7)
    await Promise.resolve()
    await Promise.resolve()
    expect(order.slice(-2)).toEqual(['retire-guest', 'retire-renderer-page'])
    acknowledgeDestroyed()
    await expect(retiring).resolves.toBe(true)
    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
  })

  it('attempts every cleanup and keeps a failed retirement fenced', async () => {
    const { executor, order, renderer } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    renderer.retirePage.mockImplementationOnce(async () => {
      order.push('retire-renderer-page')
      throw new Error('renderer cleanup failed')
    })

    await expect(executor.retirePage('page-a', 7)).rejects.toThrow(
      'Browser client page cleanup failed'
    )
    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
    expect(executor.hasPage('page-a', 7)).toBe(true)
    await expect(
      executor.handle(
        createCommand('createPage', { pageHostGeneration: 8 }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_generation_conflict'
    })
  })

  it('waits for guest destruction when renderer retirement fails', async () => {
    const { dependencies, executor, order, renderer } = createHarness()
    let acknowledgeDestroyed = (): void => {}
    const destroyed = new Promise<void>((resolve) => {
      acknowledgeDestroyed = resolve
    })
    dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce((registration) => {
      order.push('claim-guest')
      return createLifecycleClaim(registration, destroyed)
    })
    dependencies.routeWebContents.beginGuestRetirement.mockImplementationOnce(() => {
      order.push('retire-guest')
      return destroyed
    })
    renderer.retirePage.mockImplementationOnce(async () => {
      order.push('retire-renderer-page')
      throw new Error('renderer cleanup failed')
    })
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    const retiring = executor.retirePage('page-a', 7)
    await Promise.resolve()
    await Promise.resolve()
    expect(order.slice(-2)).toEqual(['retire-guest', 'retire-renderer-page'])

    acknowledgeDestroyed()
    await expect(retiring).rejects.toThrow('Browser client page cleanup failed')
    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
  })

  it('rejects a route resolved for a different execution host and releases it', async () => {
    const { dependencies, executor, route } = createHarness()
    route.key = 'execution-host-b'

    await expect(
      executor.handle(createCommand('createPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_execution_host_stale'
    })
    expect(dependencies.routeSessions.preparePage).not.toHaveBeenCalled()
    expect(route.release).toHaveBeenCalledOnce()
  })

  it('bounds retained and concurrently creating page generations', async () => {
    const { dependencies, executor, route } = createHarness({ maxPages: 1 })
    let resolveRoute = (_route: typeof route): void => {}
    dependencies.retainNetworkRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRoute = resolve
        })
    )

    const first = executor.handle(createCommand('createPage'), new AbortController().signal)
    await Promise.resolve()
    await expect(
      executor.handle(
        createCommand('createPage', { browserPageId: 'page-b', commandId: 'create-b' }),
        new AbortController().signal
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'browser_client_page_capacity' })
    resolveRoute(route)
    await expect(first).resolves.toEqual({ status: 'completed' })
  })

  it('does not retain a page when close races its in-flight creation', async () => {
    const { dependencies, executor, order, route } = createHarness()
    let resolveRoute = (_route: typeof route): void => {}
    dependencies.retainNetworkRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRoute = resolve
        })
    )
    const creating = executor.handle(createCommand('createPage'), new AbortController().signal)
    await Promise.resolve()

    await expect(executor.close()).rejects.toThrow('Browser client page executor cleanup failed')
    resolveRoute(route)

    await expect(creating).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })
    expect(executor.hasPage('page-a', 7)).toBe(false)
    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
  })

  it('retires every retained page before fencing later commands', async () => {
    const { executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    await executor.close()

    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
    await expect(
      executor.handle(createCommand('navigate'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })
  })
})
