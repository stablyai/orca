import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCommand,
  createHarness,
  createLifecycleClaim
} from './browser-client-page-command-executor-test-harness'

describe('BrowserClientPageCommandExecutor', () => {
  beforeEach(() => vi.restoreAllMocks())

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
})
