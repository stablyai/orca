import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length)
}))

describe('relay reconnect controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one retry timer when recovery changes from capacity to host offline', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayOuterError(4429))
    reconnect.registerFailure(new RelayOuterError(4408))
    expect(vi.getTimerCount()).toBe(1)

    reconnect.registerFailure(new RelayOuterError(4404))
    expect(vi.getTimerCount()).toBe(1)
    expect(reconnect.shouldDefer()).toBe(true)
    vi.advanceTimersByTime(9_999)
    expect(onRetry).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('drops a pending relay retry after direct connectivity wins', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayOuterError(4408))
    expect(vi.getTimerCount()).toBe(1)

    reconnect.resetForDirectConnection()
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('reprobes slowly after rejected E2EE authentication instead of parking forever', () => {
    // Why: on a relay-only phone a permanent gate is a permanent outage — the
    // desktop can commit pairing credentials moments after the first rejection.
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new MobileE2EEAuthenticationError())

    expect(reconnect.shouldDefer()).toBe(true)
    expect(onRetry).not.toHaveBeenCalled()
    vi.advanceTimersByTime(59_000)
    expect(onRetry).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(onRetry).toHaveBeenCalledTimes(1)
    // The reprobe tick passes the gate exactly once, then defers again.
    expect(reconnect.shouldDefer()).toBe(false)
    expect(reconnect.shouldDefer()).toBe(true)
  })

  it('keeps the fresh-credential gate reprobing after each failed gated attempt', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayOuterError(4401))
    expect(reconnect.shouldDefer()).toBe(true)

    vi.advanceTimersByTime(60_000)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(reconnect.shouldDefer()).toBe(false)
    // The gated attempt fails again with only rejected credentials on hand.
    reconnect.registerFailure(new RelayOuterError(4401))

    // The gated cadence escalates: the second reprobe waits twice as long.
    vi.advanceTimersByTime(60_000)
    expect(onRetry).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('resets the gated cadence when the app returns to the foreground', () => {
    // Why: reopening the app is the strongest "conditions changed" signal a
    // phone produces — it must not wait out an escalated 15-minute tick even
    // when it cannot lift the credential gate itself.
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)
    const logical = { getState: () => 'disconnected' } as never

    reconnect.registerFailure(new RelayOuterError(4401))
    vi.advanceTimersByTime(60_000)
    expect(onRetry).toHaveBeenCalledTimes(1)
    // A failed gated attempt escalates the next tick beyond the base cadence.
    reconnect.registerFailure(new RelayOuterError(4401))

    reconnect.clear()
    reconnect.handleForeground(logical, false)
    expect(onRetry).toHaveBeenCalledTimes(2)

    expect(reconnect.shouldDefer()).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(onRetry).toHaveBeenCalledTimes(3)
  })

  it('does not let an orphaned reprobe timer swallow the next fast backoff', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)
    const logical = { getState: () => 'disconnected' } as never

    reconnect.registerFailure(new MobileE2EEAuthenticationError())
    // A foreground revival nudge clears the external-signal gate and its timer.
    reconnect.handleForeground(logical, true)
    expect(onRetry).toHaveBeenCalledTimes(1)

    // A plain transport failure must schedule its own fast retry, not wait
    // out a leftover 60s reprobe timer.
    reconnect.registerFailure(new RelayOuterError(4429))
    vi.advanceTimersByTime(600)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('lifts the fresh-credential gate when a durable bundle carries a new version', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.recordRejectedCredential(2)
    reconnect.armCredentialReprobe()
    expect(reconnect.shouldDefer()).toBe(true)

    reconnect.acceptFreshCredential(2)
    expect(reconnect.shouldDefer()).toBe(true)

    reconnect.acceptFreshCredential(3)
    expect(reconnect.shouldDefer()).toBe(false)
    expect(
      reconnect.eligibleCredentials(
        { token: 'fresh', version: 3, expiresAt: Number.MAX_SAFE_INTEGER },
        null
      )
    ).toHaveLength(1)
  })

  it('upgrades host-revival gating to fresh credentials without later downgrading it', () => {
    const reconnect = createController(vi.fn())

    reconnect.registerFailure(new RelayOuterError(4404))
    reconnect.registerFailure(new RelayOuterError(4401))
    reconnect.registerFailure(new RelayOuterError(4408))

    expect(reconnect.resetForDirectConnection()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('extends forced-rotation retries to the exponential cooldown', () => {
    const reconnect = createController(vi.fn())

    for (let failure = 0; failure < 6; failure++) {
      reconnect.registerFailure(new RelayOuterError(4429), false)
    }

    expect(reconnect.retryDelayMs(5000)).toBe(8000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reset backoff merely because a failed attempt took one ceiling', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayOuterError(4429))
    vi.advanceTimersByTime(250)
    expect(onRetry).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(30_000)
    reconnect.registerFailure(new RelayOuterError(4429))
    vi.advanceTimersByTime(249)
    expect(onRetry).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(onRetry).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(249)
    expect(onRetry).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('resets backoff after an authenticated relay remains stable', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)
    const session = {
      getFailure: () => new RelayOuterError(4408)
    } as MobileRelayRpcSession
    const logical = {
      getActivePath: () => 'relay'
    } as StableLogicalRpcClient

    reconnect.registerFailure(new RelayOuterError(4429))
    vi.advanceTimersByTime(250)
    reconnect.setActiveSession(session)
    vi.advanceTimersByTime(30_000)
    reconnect.registerActiveFailure(logical)

    vi.advanceTimersByTime(249)
    expect(onRetry).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('uses grace only when the outer relay credential was rejected', () => {
    const reconnect = createController(vi.fn())

    expect(reconnect.shouldTryGraceAfterRelayFailure(new RelayOuterError(4401))).toBe(true)
    expect(reconnect.shouldTryGraceAfterRelayFailure(new Error('relay transport error'))).toBe(
      false
    )
    expect(reconnect.shouldTryGraceAfterRelayFailure(new RelayOuterError(4408))).toBe(false)
    expect(reconnect.shouldTryGraceAfterRelayFailure(new RelayOuterError(4429))).toBe(false)
  })
})

function createController(onRetry: () => void): RelayReconnectController {
  return new RelayReconnectController(
    {
      now: Date.now,
      randomBytes: () => new Uint8Array([128, 0]),
      setTimer: setTimeout,
      clearTimer: clearTimeout
    },
    onRetry
  )
}
