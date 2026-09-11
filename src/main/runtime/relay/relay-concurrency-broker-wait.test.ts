import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayAuthCoordinator,
  type CoordinatedRelayBroker,
  type LiveBrokerWaitResult,
  type RelayAuthContext
} from './relay-auth-coordinator'
import { RelayHttpError } from './relay-http-client'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

// Reads a wait without ever awaiting it, so a waiter that never settles fails an
// assertion instead of hanging out to the runner timeout — which is what every
// leak in this file looks like.
function observe(wait: Promise<LiveBrokerWaitResult>): () => LiveBrokerWaitResult | 'unsettled' {
  let seen: LiveBrokerWaitResult | 'unsettled' = 'unsettled'
  void wait.then((result) => {
    seen = result
  })
  return () => seen
}

afterEach(() => {
  vi.useRealTimers()
})

describe('relay live-broker wait under interleaving', () => {
  it('hands a waiter the broker a newer reconcile registered instead of the abandoned open', async () => {
    // A reconcile settles mid-wait. The waiter joined the previous one, whose
    // result is discarded — parking on it held the caller behind an open nobody
    // would use, for as long as that open took to time out.
    vi.useFakeTimers()
    const abandoned = deferred<CoordinatedRelayBroker>()
    const fresh = { closeNow: vi.fn() }
    let opens = 0
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: async () => {
        opens += 1
        return opens === 1 ? await abandoned.promise : fresh
      },
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(opens).toBe(1)

    const seen = observe(coordinator.waitForLiveBrokerResult(20_000))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen()).toBe('unsettled')

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getLiveBroker()).toBe(fresh)

    expect(seen()).toEqual({ broker: fresh })
    coordinator.stop()
  })

  it('follows a superseding reconcile that is still opening rather than answering from the old one', async () => {
    // The other half of a mid-wait supersession: waking the waiter is only
    // right if it then joins the newer reconcile. Answering as soon as it wakes
    // would report "no broker, no cause" while the open that will supply one is
    // still in flight.
    vi.useFakeTimers()
    const opens = [deferred<CoordinatedRelayBroker>(), deferred<CoordinatedRelayBroker>()]
    const broker = { closeNow: vi.fn() }
    let call = 0
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: () => opens[call++]!.promise,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    const seen = observe(coordinator.waitForLiveBrokerResult(20_000))
    await vi.advanceTimersByTimeAsync(0)

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toBe(2)
    expect(seen()).toBe('unsettled')

    opens[1]!.resolve(broker)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen()).toEqual({ broker })
    coordinator.stop()
  })

  it('does not let the first waiter off an armed retry strand or answer for the second', async () => {
    // Two waiters share one armed schedule. The short-budget one giving up must
    // neither cancel the retry nor leave the long-budget one on a signal that
    // has already fired.
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 500))
      .mockResolvedValue(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)

    const short = observe(coordinator.waitForLiveBrokerResult(100))
    const long = observe(coordinator.waitForLiveBrokerResult(20_000))
    await vi.advanceTimersByTimeAsync(100)
    expect(short()).toEqual({ broker: null, offlineReason: 'broker_unavailable' })
    expect(long()).toBe('unsettled')

    // The retry the short waiter walked away from still fires, and its result
    // reaches the waiter that stayed.
    await vi.advanceTimersByTimeAsync(400)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(long()).toEqual({ broker })
    coordinator.stop()
  })

  it('lets the armed retry take the tie when it fires on the tick the budget expires', async () => {
    // attempt 0 with random 0.5 is a 500ms delay; the budget matches it exactly.
    // The retry wins the tick, so the caller is told the fresh attempt's cause
    // rather than the generic no-cause result.
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

    const seen = observe(coordinator.waitForLiveBrokerResult(500))
    await vi.advanceTimersByTimeAsync(500)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(seen()).toEqual({ broker: null, offlineReason: 'broker_unavailable' })
    coordinator.stop()
  })

  it('settles a waiter parked on an armed retry when the coordinator stops, leaving no timer', async () => {
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
    const seen = observe(coordinator.waitForLiveBrokerResult(20_000))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    coordinator.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen()).toEqual({ broker: null, offlineReason: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives a waiter the terminal cause that landed while its retry was armed', async () => {
    vi.useFakeTimers()
    let current: RelayAuthContext | null = context
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 500))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    const seen = observe(coordinator.waitForLiveBrokerResult(20_000))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen()).toBe('unsettled')

    current = null
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen()).toEqual({ broker: null, offlineReason: 'signed-out' })

    // The retryable schedule the terminal cause superseded must arm nothing.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(openBroker).toHaveBeenCalledTimes(1)
    coordinator.stop()
  })
})
