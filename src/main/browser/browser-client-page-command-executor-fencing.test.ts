import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommand, createHarness } from './browser-client-page-command-executor-test-harness'

describe('BrowserClientPageCommandExecutor authority fencing', () => {
  beforeEach(() => vi.restoreAllMocks())

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
    expect(order).toEqual(['release-route'])
  })

  it('retires every retained page before fencing later commands', async () => {
    const { executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    await executor.close()

    expect(order.slice(-6)).toEqual([
      'revoke-navigation',
      'release-guest',
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

  it('revokes retained navigation once without inferring guest destruction', async () => {
    const { dependencies, executor, order, route } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    executor.fenceNavigation()
    executor.fenceNavigation()

    expect(dependencies.routeWebContents.revokeNavigation).toHaveBeenCalledOnce()
    expect(order.at(-1)).toBe('revoke-navigation')
    expect(route.release).not.toHaveBeenCalled()
    await expect(
      executor.handle(createCommand('navigate'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })
    await executor.close()
  })

  it('retains inventory while fencing old pages and uses the replacement route identity', async () => {
    const { dependencies, executor } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)

    executor.beginAuthorityTransition()

    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', authorityRuntimeId: 'runtime-a' })
    ])
    expect(dependencies.routeWebContents.revokeNavigation).toHaveBeenCalledOnce()
    await expect(
      executor.handle(createCommand('navigate'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })

    executor.completeAuthorityTransition({
      authorityConnectionIdentity: 'authority-record-b',
      legacyAuthorityConnectionIdentity: 'legacy-authority-record-b'
    })
    await expect(
      executor.handle(
        createCommand('navigate', {
          authorityRuntimeId: 'runtime-b',
          authorityEpoch: 'epoch-b',
          browserHostGeneration: 1
        }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_generation_stale'
    })
    expect(dependencies.routeWebContents.navigateGuest).not.toHaveBeenCalled()

    await executor.retirePage('page-a', 7)
    await executor.handle(
      createCommand('createPage', {
        authorityRuntimeId: 'runtime-b',
        authorityEpoch: 'epoch-b',
        browserPageId: 'page-b',
        pageHostGeneration: 1
      }),
      new AbortController().signal
    )

    expect(dependencies.routeSessions.preparePage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ authorityConnectionIdentity: 'authority-record-b' })
      })
    )
  })

  it('releases an in-flight old-authority create during transition', async () => {
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

    executor.beginAuthorityTransition()
    resolveRoute(route)

    await expect(creating).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })
    expect(executor.snapshotPageInventory()).toEqual([])
    expect(dependencies.routeWebContents.grantNavigation).not.toHaveBeenCalled()
    expect(order).toEqual(['release-route'])
    executor.completeAuthorityTransition({
      authorityConnectionIdentity: 'authority-record-b',
      legacyAuthorityConnectionIdentity: 'legacy-authority-record-b'
    })
    await executor.close()
  })

  it('keeps transition fail-closed when navigation revocation throws', async () => {
    const { dependencies, executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    dependencies.routeWebContents.revokeNavigation.mockImplementationOnce(() => {
      order.push('revoke-navigation')
      throw new Error('transition revocation failed')
    })

    expect(() => executor.beginAuthorityTransition()).toThrow(
      'Browser client page navigation fencing failed'
    )
    await expect(
      executor.handle(createCommand('navigate'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })

    await executor.close()
    expect(order.slice(-6)).toEqual([
      'revoke-navigation',
      'release-guest',
      'retire-guest',
      'retire-renderer-page',
      'release-session',
      'release-route'
    ])
  })

  it('continues exact page cleanup when navigation revocation throws', async () => {
    const { dependencies, executor, order } = createHarness()
    await executor.handle(createCommand('createPage'), new AbortController().signal)
    dependencies.routeWebContents.revokeNavigation.mockImplementationOnce(() => {
      order.push('revoke-navigation')
      throw new Error('navigation revocation failed')
    })

    await expect(executor.close()).rejects.toMatchObject({
      message: 'Browser client page navigation fencing failed',
      errors: [expect.objectContaining({ message: 'navigation revocation failed' })]
    })

    expect(order.slice(-6)).toEqual([
      'revoke-navigation',
      'release-guest',
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

  it('prevents an in-flight creation from granting navigation after fencing', async () => {
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

    executor.fenceNavigation()
    resolveRoute(route)

    await expect(creating).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })
    expect(dependencies.routeWebContents.grantNavigation).not.toHaveBeenCalled()
    expect(order).toEqual(['release-route'])
    await executor.close()
  })
})
