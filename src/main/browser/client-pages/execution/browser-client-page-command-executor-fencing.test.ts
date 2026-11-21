import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommand, createHarness } from './browser-client-page-command-executor-test-harness'

describe('BrowserClientPageCommandExecutor authority fencing', () => {
  beforeEach(() => vi.restoreAllMocks())

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
      pairingAuthorityConnectionIdentity: 'pairing-authority-record-b',
      legacyAuthorityConnectionIdentity: 'legacy-authority-record-b'
    })
    await executor.close()
  })
})
