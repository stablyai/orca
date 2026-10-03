import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'
import { RelayHttpError } from './relay-http-client'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RelayAuthCoordinator transient recovery', () => {
  it('retries a transient assignment failure and activates without an external event', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 500))
      .mockResolvedValueOnce(broker)
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: (status) => statuses.push(status),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('offline')

    await vi.advanceTimersByTimeAsync(501)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(coordinator.getActiveBroker()).toBe(broker)
    expect(statuses.at(-1)).toBe('registered')
  })

  it('does not retry initial relay setup before the server Retry-After window', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503, 30_000))
      .mockResolvedValueOnce(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(openBroker).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(coordinator.getActiveBroker()).toBe(broker)
  })

  it('retries when cloud-session refresh fails before identity can be read', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const readContext = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary cloud session refresh failure'))
      .mockResolvedValueOnce(context)
    const openBroker = vi.fn().mockResolvedValue(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(readContext).toHaveBeenCalledOnce()
    expect(openBroker).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(501)
    expect(readContext).toHaveBeenCalledTimes(2)
    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBe(broker)
  })

  it('backs a sustained outage off to the five-minute jitter cap', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    for (const delayMs of [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]) {
      await vi.advanceTimersByTimeAsync(delayMs)
    }
    expect(openBroker).toHaveBeenCalledTimes(10)

    await vi.advanceTimersByTimeAsync(149_999)
    expect(openBroker).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(1)
    expect(openBroker).toHaveBeenCalledTimes(11)

    await vi.advanceTimersByTimeAsync(150_000)
    expect(openBroker).toHaveBeenCalledTimes(12)
  })

  it('does not retry a permanent authorization response', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('token-exchange', 403))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('cancels a pending retry as soon as demand disappears', async () => {
    vi.useFakeTimers()
    let demanded = true
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.75
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    demanded = false
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('re-reads demand when the retry fires and stops without opening again', async () => {
    vi.useFakeTimers()
    let demanded = true
    const statuses: string[] = []
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker,
      onStatus: (status) => statuses.push(status),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    demanded = false
    await vi.advanceTimersByTimeAsync(501)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('standby')
  })

  it('re-reads entitlement when the retry fires and stops after removal', async () => {
    vi.useFakeTimers()
    let current = context
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 500))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    current = { ...context, relayEntitled: false }
    await vi.advanceTimersByTimeAsync(501)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('cancels a pending retry immediately when the coordinator is fenced', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    coordinator.fenceAndCloseNow()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('waits through a scheduled retry instead of surfacing the cold-start failure', async () => {
    // Why: a phone-initiated wait used to read the coordinator's own scheduled
    // retry as "nothing more is coming" and returned null at once, surfacing
    // relay_control_not_active for a hiccup fixed a moment later.
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 500))
      .mockResolvedValueOnce(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    const waiter = coordinator.waitForLiveBroker()
    await vi.advanceTimersByTimeAsync(501)
    await expect(waiter).resolves.toBe(broker)
  })

  it('resolves a wait for a canceled retry instead of hanging', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 500))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    const waiter = coordinator.waitForLiveBrokerResult()
    // Why: the waiter must actually be parked on the retry signal before the
    // fence, or the test passes through the early-return branch without ever
    // exercising the cancel wake-up.
    await vi.advanceTimersByTimeAsync(0)
    coordinator.fenceAndCloseNow()
    await expect(waiter).resolves.toEqual({ broker: null, offlineReason: null })
  })

  it('gives up once its wait budget elapses during a sustained outage', async () => {
    // Why: sitting through a retry must stay bounded — a real outage should
    // fail the caller clearly instead of riding the backoff ladder forever.
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 500))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)

    const waiter = coordinator.waitForLiveBroker(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(waiter).resolves.toBeNull()
    expect(openBroker.mock.calls.length).toBeGreaterThan(1)
  })

  it('never cuts an in-flight open short: a slow first open past the budget still wins', async () => {
    // Why: opens carry their own HTTP deadlines; the budget exists to bound the
    // retry chain, not to turn a slow cold start into relay_control_not_active.
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: () => new Promise((resolve) => setTimeout(() => resolve(broker), 8_000)),
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    const waiter = coordinator.waitForLiveBrokerResult(1_000)
    await vi.advanceTimersByTimeAsync(7_999)
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiter).resolves.toEqual({ broker })
  })

  it('does not hold a signed-out waiter for the budget: a terminal cause arms no retry', async () => {
    vi.useFakeTimers()
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => null,
      openBroker: vi.fn(),
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    const waiter = coordinator.waitForLiveBrokerResult(60_000)
    await vi.advanceTimersByTimeAsync(0)
    await expect(waiter).resolves.toEqual({ broker: null, offlineReason: 'signed-out' })
  })

  it('does not carry a pending retry across an identity switch', async () => {
    vi.useFakeTimers()
    let current = context
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary control open failure'))
      .mockResolvedValueOnce(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.75
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    current = {
      ...context,
      identity: { ...context.identity, profileId: 'profile-2' }
    }
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(coordinator.getActiveBroker()).toBe(broker)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledTimes(2)
  })
})

describe('RelayAuthCoordinator liveness safety net', () => {
  it('withholds a dead broker from control work while identity matching still sees it', async () => {
    vi.useFakeTimers()
    const dead = { closeNow: vi.fn(), isLive: () => false }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: vi.fn().mockResolvedValue(dead),
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getActiveBroker()).toBe(dead)
    expect(coordinator.getLiveBroker()).toBeNull()
  })

  it('treats a broker that cannot report liveness as usable, not dead', async () => {
    // Why: unverifiable is not exited — only a broker that proves its control
    // died is withheld; silence must never cost a working relay.
    vi.useFakeTimers()
    const unverifiable = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: vi.fn().mockResolvedValue(unverifiable),
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getLiveBroker()).toBe(unverifiable)
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(unverifiable)
  })

  it('reopens a broker that died leaving no retry timer behind', async () => {
    // Why: an auth refresh failing past token expiry closes the broker with
    // no timer; only ensureLive (periodic/power-resume) can revive it.
    vi.useFakeTimers()
    const dead = { closeNow: vi.fn(), isLive: () => false }
    const live = { closeNow: vi.fn(), isLive: () => true }
    const openBroker = vi.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(live)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getActiveBroker()).toBe(dead)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(openBroker).toHaveBeenCalledOnce()

    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(dead.closeNow).toHaveBeenCalled()
    expect(coordinator.getActiveBroker()).toBe(live)
  })

  it('does not disturb a live broker, a scheduled retry, or an open in flight', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn(), isLive: () => true }
    let releaseOpen: ((value: typeof broker) => void) | undefined
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503, 30_000))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOpen = resolve
          })
      )
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    // A scheduled Retry-After timer owns recovery; ensureLive must not race it.
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    // The retry fires into a slow open; ensureLive must not preempt it.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openBroker).toHaveBeenCalledTimes(2)
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    releaseOpen?.(broker)
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getActiveBroker()).toBe(broker)

    // A live broker needs nothing.
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
  })
})
