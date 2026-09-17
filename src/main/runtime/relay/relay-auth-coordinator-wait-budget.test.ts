import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

/**
 * What the live-broker wait budget does and does not bound.
 *
 * `LIVE_BROKER_WAIT_BUDGET_MS` is 20s and the deadline is checked only AFTER `await pending`, which
 * is deliberately unbounded — cutting a slow-but-succeeding open short would fail a pairing that
 * was about to work. So the budget bounds the armed-retry chain and nothing else.
 *
 * That is worth a test rather than a comment because the consequence lands on the phone:
 * `pairing.provisionRelay` reaches this through `requireActiveBroker`, and `readContext`'s own
 * ceiling is the cloud refresh timeout (60s, with one retry for a definitive 5xx) — several times
 * the phone's request budget. The phone gives up and retries while the desktop is still holding a
 * transient demand ref for the call it abandoned.
 */
describe('live-broker wait budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not bound a reconcile already in flight, so it can outlast the phone request budget', async () => {
    vi.useFakeTimers()
    let releaseContext = (): void => {}
    const coordinator = new RelayAuthCoordinator({
      readContext: () =>
        new Promise<RelayAuthContext>((resolve) => {
          releaseContext = (): void => resolve(context)
        }),
      openBroker: async () => ({ closeNow: vi.fn() }),
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await Promise.resolve()

    let settled = false
    const wait = coordinator.waitForLiveBrokerResult().then((result) => {
      settled = true
      return result
    })

    // Well past both the 20s budget and the phone's 30s request budget.
    await vi.advanceTimersByTimeAsync(45_000)
    expect(settled).toBe(false)

    releaseContext()
    await vi.advanceTimersByTimeAsync(0)
    await expect(wait).resolves.toEqual({ broker: expect.anything() })
    expect(settled).toBe(true)
  })
})
