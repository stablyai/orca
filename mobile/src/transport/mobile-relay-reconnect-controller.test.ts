import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayDirectorHttpError } from './mobile-relay-resume-director'
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

  it('publishes consecutive failures and the direct-connection reset', () => {
    const published: number[] = []
    const reconnect = createController(vi.fn(), (count) => published.push(count))

    reconnect.registerFailure(new RelayOuterError(4408), false)
    reconnect.registerFailure(new RelayOuterError(4408), false)
    reconnect.resetForDirectConnection()

    expect(published).toEqual([0, 1, 2, 0])
  })

  it('latches pairing-rejected only after the transient-rejection budget is spent', () => {
    const rejected: boolean[] = []
    const reconnect = createController(vi.fn(), undefined, (value) => rejected.push(value))

    reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    expect(rejected).toEqual([false])

    // Why: the gate is held by now, so this rejection takes registerFailure's early
    // return — pre-fix it was invisible and the latch never fired (STA-4681).
    reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    expect(rejected).toEqual([false, true])
  })

  it('keeps the pairing-rejected latch across a gate lift and app resume', () => {
    const logical = { getState: () => 'disconnected' } as never
    const rejected: boolean[] = []
    const reconnect = createController(vi.fn(), undefined, (value) => rejected.push(value))
    for (let attempt = 0; attempt < 3; attempt++) {
      reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    }

    // Why: a resume re-arms the retry cadence but is not the desktop changing its
    // mind — only an authenticated session is.
    reconnect.handleForeground(logical, false)

    expect(rejected).toEqual([false, true])
  })

  it('never latches pairing-rejected while an authenticated relay is still live', () => {
    // Why: a live authenticated session is the desktop currently accepting this
    // device. A replacement dial that trips E2EE (relay identity mismatch, or the
    // transient window while the desktop commits a rotation) is not revocation, and
    // banking it would fire a false re-pair alarm the moment that session drops.
    const rejected: boolean[] = []
    const reconnect = createController(vi.fn(), undefined, (value) => rejected.push(value))
    reconnect.setActiveSession({ getFailure: () => null } as unknown as MobileRelayRpcSession)

    for (let attempt = 0; attempt < 3; attempt++) {
      reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    }

    expect(rejected).toEqual([false])
  })

  it('clears the pairing-rejected latch once the desktop authenticates the device', () => {
    const rejected: boolean[] = []
    const reconnect = createController(vi.fn(), undefined, (value) => rejected.push(value))
    for (let attempt = 0; attempt < 3; attempt++) {
      reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    }

    reconnect.setActiveSession({ getFailure: () => null } as unknown as MobileRelayRpcSession)

    expect(rejected).toEqual([false, true, false])
  })

  it('clears the pairing-rejected latch when direct connectivity proves the pairing', () => {
    const rejected: boolean[] = []
    const reconnect = createController(vi.fn(), undefined, (value) => rejected.push(value))
    for (let attempt = 0; attempt < 3; attempt++) {
      reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    }

    // Why: direct auth resolves the same desktop device registry.
    reconnect.resetForDirectConnection()

    expect(rejected).toEqual([false, true, false])
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

  it('mints the gate pass when arming a no-bundle reprobe under a held gate', () => {
    // Why: an external-signal gate never records rejected versions, so the
    // no-dialable-bundle path must still mint the tick's pass token — a plain
    // cooldown tick bounces off shouldDefer and doubles the effective cadence.
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new MobileE2EEAuthenticationError())
    expect(reconnect.shouldDefer()).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(reconnect.shouldDefer()).toBe(false)
    // The gated attempt finds no dialable credential at all and re-arms.
    reconnect.armCredentialReprobe()

    vi.advanceTimersByTime(120_000)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(reconnect.shouldDefer()).toBe(false)
  })

  it('does not arm a gate reprobe timer when the supervisor declined retries', () => {
    // Why: scheduleRetry=false means background or stopped — a tick firing
    // there wakes nothing useful, and the next foreground resume re-arms.
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)
    const logical = { getState: () => 'disconnected' } as never

    reconnect.registerFailure(new MobileE2EEAuthenticationError(), false)
    expect(vi.getTimerCount()).toBe(0)
    reconnect.registerFailure(new RelayOuterError(4401), false)
    expect(vi.getTimerCount()).toBe(0)
    reconnect.registerFailure(new RelayOuterError(4429), false)
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(onRetry).not.toHaveBeenCalled()

    // Resume restores the gated cadence instead of stalling forever.
    reconnect.handleForeground(logical, false)
    expect(reconnect.shouldDefer()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
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

  it('paces the next dial by the director Retry-After instead of the local backoff', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayDirectorHttpError(503, 30_000))

    expect(reconnect.retryDelayMs(0)).toBe(30_000)
    vi.advanceTimersByTime(29_999)
    expect(onRetry).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps the local backoff when the director sent no Retry-After', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayDirectorHttpError(500, null))

    expect(reconnect.retryDelayMs(0)).toBe(250)
    vi.advanceTimersByTime(250)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('never lets a short Retry-After shorten an escalated backoff', () => {
    const reconnect = createController(vi.fn())

    for (let failure = 0; failure < 6; failure++) {
      reconnect.registerFailure(new RelayOuterError(4429), false)
    }
    reconnect.registerFailure(new RelayDirectorHttpError(503, 100), false)

    expect(reconnect.retryDelayMs(0)).toBe(15_000)
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

function createController(
  onRetry: () => void,
  reportFailureCount: (count: number) => void = () => {},
  reportPairingRejected: (rejected: boolean) => void = () => {}
): RelayReconnectController {
  const controller = new RelayReconnectController(
    {
      now: Date.now,
      randomBytes: () => new Uint8Array([128, 0]),
      setTimer: setTimeout,
      clearTimer: clearTimeout
    },
    onRetry
  )
  controller.reportRecoveryTo({
    setRecoveryAttempt: reportFailureCount,
    setPairingRejected: reportPairingRejected
  } as unknown as StableLogicalRpcClient)
  return controller
}
