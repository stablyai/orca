import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCommand,
  createHarness,
  createLifecycleClaim,
  partition
} from './browser-client-page-command-executor-test-harness'

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
      'grant-navigation',
      'bind-guest'
    ])
    // Downloads must resolve this page before its first navigation, without an automation command.
    expect(dependencies.guestBinding.bind).toHaveBeenCalledWith({
      registration: {
        partition,
        browserPageId: 'page-a',
        pageHostGeneration: 7,
        rendererWebContentsId: 11,
        webContentsId: 41
      },
      browserProfileId: 'profile-a'
    })
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
      legacyIdentity: {
        orcaProfileId: 'orca-profile-a',
        browserProfileId: 'profile-a',
        authorityConnectionIdentity: 'legacy-authority-record-a',
        executionHostIdentity: 'legacy-execution-host-record-a'
      },
      storageScope: 'a'.repeat(64),
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
    expect(executor.snapshotPageInventory()).toEqual([
      {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'client-a',
        browserHostGeneration: 3,
        browserPageId: 'page-a',
        pageHostGeneration: 7,
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-host-a',
        state: 'active',
        currentUrl: 'https://example.internal/path'
      }
    ])
  })

  it('executes one automation envelope against the exact retained page', async () => {
    const { dependencies, executor } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    const command = createCommand('navigate', {
      commandId: 'automation-a',
      command: {
        type: 'automation',
        method: 'browser.click',
        params: { element: 'Submit' }
      }
    })

    await expect(executor.handle(command, new AbortController().signal)).resolves.toEqual({
      status: 'completed',
      value: { clicked: true }
    })
    expect(dependencies.executeAutomation).toHaveBeenCalledWith(
      {
        browserPageId: 'page-a',
        pageHostGeneration: 7,
        browserProfileId: 'profile-a',
        method: 'browser.click',
        params: { element: 'Submit' },
        registration: expect.objectContaining({ browserPageId: 'page-a', webContentsId: 41 })
      },
      expect.any(AbortSignal)
    )
  })

  it('keeps legacy-valid command identities when inventory cannot encode them', async () => {
    const { executor } = createHarness()
    const browserProfileId = '\0'.repeat(256)

    await expect(
      executor.handle(
        createCommand('createPage', {
          command: { type: 'createPage', browserProfileId, executionHostKey: 'execution-host-a' }
        }),
        new AbortController().signal
      )
    ).resolves.toEqual({ status: 'completed' })
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserProfileId, state: 'active' })
    ])
  })

  it('omits a normalized URL that expands beyond the inventory field bound', async () => {
    const { dependencies, executor } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    const requestedUrl = `https://example.internal/${'é'.repeat(4_000)}`

    await expect(
      executor.handle(
        createCommand('navigate', { command: { type: 'navigate', url: requestedUrl } }),
        new AbortController().signal
      )
    ).resolves.toEqual({ status: 'completed' })

    expect(dependencies.routeWebContents.navigateGuest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/^https:\/\/example\.internal\/%C3%A9%C3%A9/)
    )
    expect(executor.snapshotPageInventory()[0]).not.toHaveProperty('currentUrl')
  })

  it('snapshots in-flight and unresolved pages as outcome unknown', async () => {
    const { dependencies, executor, route } = createHarness()
    let resolveRoute = (_route: typeof route): void => {}
    dependencies.retainNetworkRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRoute = resolve
        })
    )
    const creating = executor.handle(createCommand('createPage'), new AbortController().signal)
    await Promise.resolve()

    const inFlight = executor.snapshotPageInventory()
    expect(inFlight).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
    expect(Object.isFrozen(inFlight)).toBe(true)
    expect(Object.isFrozen(inFlight[0])).toBe(true)

    resolveRoute(route)
    await expect(creating).resolves.toEqual({ status: 'completed' })
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'active' })
    ])
  })

  it('never duplicates a page during its create-to-active transition', async () => {
    const { dependencies, executor, order } = createHarness()
    let transitionSnapshot: ReturnType<typeof executor.snapshotPageInventory> = []
    dependencies.routeWebContents.grantNavigation.mockImplementationOnce(() => {
      order.push('grant-navigation')
      queueMicrotask(() => {
        transitionSnapshot = executor.snapshotPageInventory()
      })
      return true
    })

    await executor.handle(createCommand('createPage'), new AbortController().signal)

    expect(transitionSnapshot).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'active' })
    ])
  })

  it('never reports a page as active after its renderer authority is replaced', async () => {
    const { executor, setRendererCurrent } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    setRendererCurrent(false)

    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
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
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
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
    const { dependencies, executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    await expect(executor.retirePage('page-a', 8)).resolves.toBe(false)
    expect(executor.hasPage('page-a', 7)).toBe(true)
    expect(dependencies.guestBinding.release).not.toHaveBeenCalled()
    await expect(executor.retirePage('page-a', 7)).resolves.toBe(true)
    expect(dependencies.guestBinding.release).toHaveBeenCalledWith({
      partition,
      browserPageId: 'page-a',
      pageHostGeneration: 7,
      rendererWebContentsId: 11,
      webContentsId: 41
    })
    expect(order.slice(-5)).toEqual([
      'release-guest',
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
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
    acknowledgeDestroyed()
    await expect(retiring).resolves.toBe(true)
    expect(order.slice(-4)).toEqual([
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
  })

  it('moves a failed retirement into immutable outcome-unknown inventory', async () => {
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
    expect(executor.hasPage('page-a', 7)).toBe(false)
    expect(executor.hasUnresolvedPage('page-a', 7)).toBe(true)
    const inventory = executor.snapshotPageInventory()
    expect(inventory).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
    expect(Object.isFrozen(inventory[0])).toBe(true)
    // The unresolved record answers for its exact generation only.
    expect(executor.hasUnresolvedPage('page-a', 8)).toBe(false)
    await expect(executor.retirePage('page-a', 7)).resolves.toBe(false)
    await expect(
      executor.handle(
        createCommand('createPage', { pageHostGeneration: 8 }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_generation_conflict'
    })
    // Close must report the unresolved page rather than claim a clean teardown.
    await expect(executor.close()).rejects.toMatchObject({
      message: 'Browser client page executor cleanup failed',
      errors: [expect.objectContaining({ message: 'browser_client_page_cleanup_unresolved' })]
    })
  })

  it('reports every page whose cleanup fails during close', async () => {
    const { executor, order, renderer } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    renderer.retirePage.mockImplementationOnce(async () => {
      order.push('retire-renderer-page')
      throw new Error('renderer cleanup failed')
    })

    await expect(executor.close()).rejects.toMatchObject({
      message: 'Browser client page executor cleanup failed',
      errors: [expect.objectContaining({ message: 'Browser client page cleanup failed' })]
    })
  })

  it('joins an in-flight retirement instead of running cleanup twice', async () => {
    const { executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    const [first, second] = await Promise.all([
      executor.retirePage('page-a', 7),
      executor.retirePage('page-a', 7)
    ])

    expect([first, second]).toEqual([true, true])
    expect(order.filter((step) => step === 'release-route')).toHaveLength(1)
    expect(order.filter((step) => step === 'release-session')).toHaveLength(1)
  })

  it('refuses an authority transition on a closed executor', async () => {
    const { executor } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    await executor.close()

    expect(() => executor.beginAuthorityTransition()).toThrow(
      'browser_client_page_authority_transition_unavailable'
    )
  })

  it('refuses to complete an authority transition that never began', () => {
    const { executor } = createHarness()

    expect(() =>
      executor.completeAuthorityTransition({
        authorityConnectionIdentity: 'authority-record-b',
        legacyAuthorityConnectionIdentity: 'legacy-authority-record-b'
      })
    ).toThrow('browser_client_page_authority_transition_unavailable')
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

  it('rejects a page limit above the attach inventory maximum', () => {
    expect(() => createHarness({ maxPages: 257 })).toThrow('browser_client_page_limit_invalid')
  })
})
