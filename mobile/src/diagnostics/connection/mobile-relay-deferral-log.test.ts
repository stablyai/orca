import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRelayDeferralLog } from './mobile-relay-deferral-log'
import { RelayReconnectController } from '../../transport/relay/mobile-relay-reconnect-controller'
import { RelayOuterError } from '../../transport/encryption/mobile-relay-e2ee-link'

describe('relay recovery deferral log', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes one line per reason per 30s and counts the rest', () => {
    const log = vi.fn()
    const logDeferral = createRelayDeferralLog(log, Date.now)
    for (let i = 0; i < 20; i++) {
      logDeferral({ reason: 'cooldown', remainingMs: 9_000 - i * 1_000 })
      vi.advanceTimersByTime(1_000)
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenLastCalledWith('recovery deferred by cooldown', 'retryInMs=9000')

    vi.advanceTimersByTime(10_000)
    logDeferral({ reason: 'cooldown', remainingMs: 4_000 })
    expect(log).toHaveBeenLastCalledWith(
      'recovery deferred by cooldown',
      'retryInMs=4000 suppressedSinceLastLine=19'
    )
  })

  it('logs a change of gate at once', () => {
    const log = vi.fn()
    const logDeferral = createRelayDeferralLog(log, Date.now)
    logDeferral({ reason: 'cooldown', remainingMs: 1_000 })
    logDeferral({ reason: 'fresh-credential', remainingMs: 60_000 })
    expect(log).toHaveBeenLastCalledWith(
      'recovery deferred by gate=fresh-credential',
      'retryInMs=60000'
    )
  })

  it('reports the gate in force and the time left until its reprobe', () => {
    const controller = new RelayReconnectController(
      {
        now: Date.now,
        // Midpoint jitter: the first gate reprobe lands at 60s.
        randomBytes: () => new Uint8Array([128, 0]),
        setTimer: (callback, delay) => setTimeout(callback, delay),
        clearTimer: clearTimeout
      },
      () => {}
    )
    expect(controller.deferral()).toBeNull()
    controller.registerFailure(new RelayOuterError(4401))
    vi.advanceTimersByTime(20_000)
    expect(controller.deferral()).toEqual({ reason: 'fresh-credential', remainingMs: 40_000 })
  })
})
