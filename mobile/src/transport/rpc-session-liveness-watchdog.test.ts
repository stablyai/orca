import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIVENESS_IDLE_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  RpcSessionLivenessWatchdog
} from './rpc-session-liveness-watchdog'

describe('RpcSessionLivenessWatchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function fixture() {
    const sendProbe = vi.fn(() => true)
    const terminate = vi.fn()
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe,
      terminate,
      now: Date.now
    })
    const identity = {}
    watchdog.start(identity)
    return { identity, sendProbe, terminate, watchdog }
  }

  it('probes only after authenticated-inbound idle', async () => {
    const { identity, sendProbe, watchdog } = fixture()
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS - 1)
    expect(sendProbe).not.toHaveBeenCalled()

    watchdog.noteAuthenticatedInbound(identity)
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS - 1)
    expect(sendProbe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sendProbe).toHaveBeenCalledOnce()
  })

  it('requires three fair consecutive misses', async () => {
    const { identity, terminate, watchdog } = fixture()
    watchdog.probeNow(identity)

    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS * 2)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS)
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledWith(identity)
  })

  it('reports causal evidence before terminating a stale session', async () => {
    const onTimeout = vi.fn()
    const terminate = vi.fn()
    const identity = {}
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'relay',
      idleProbeMs: null,
      probeTimeoutMs: 4_000,
      missedProbeLimit: 2,
      sendProbe: () => true,
      terminate,
      onTimeout,
      now: Date.now
    })
    watchdog.start(identity)
    watchdog.probeNow(identity)

    await vi.advanceTimersByTimeAsync(8_000)

    expect(onTimeout).toHaveBeenCalledWith({
      transport: 'relay',
      reason: 'probe-timeout',
      missedProbes: 2,
      missedProbeLimit: 2,
      lastInboundAgeMs: 8_000
    })
    expect(onTimeout.mock.invocationCallOrder[0]).toBeLessThan(
      terminate.mock.invocationCallOrder[0]!
    )
  })

  it('authenticated activity resets suspicion', async () => {
    const { identity, terminate, watchdog } = fixture()
    watchdog.probeNow(identity)
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS)
    watchdog.noteAuthenticatedInbound(identity)
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS + LIVENESS_PROBE_TIMEOUT_MS * 2)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('does not churn timers during continuous authenticated traffic', async () => {
    const setTimer = vi.fn(setTimeout)
    const sendProbe = vi.fn(() => true)
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe,
      terminate: vi.fn(),
      now: Date.now,
      setTimer
    })
    const identity = {}
    watchdog.start(identity)

    await vi.advanceTimersByTimeAsync(10_000)
    for (let index = 0; index < 100; index++) {
      watchdog.noteAuthenticatedInbound(identity)
    }
    expect(setTimer).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(sendProbe).not.toHaveBeenCalled()
    expect(setTimer).toHaveBeenCalledTimes(2)
  })

  it('does not charge a scheduler-stalled probe window', () => {
    let now = 0
    let callback: (() => void) | null = null
    const terminate = vi.fn()
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'relay',
      idleProbeMs: null,
      probeTimeoutMs: 4_000,
      missedProbeLimit: 2,
      sendProbe: () => true,
      terminate,
      now: () => now,
      setTimer: (next) => {
        callback = next
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    const identity = {}
    watchdog.start(identity)
    watchdog.probeNow(identity)
    now = 8_000
    callback?.()
    now += 4_000
    callback?.()
    expect(terminate).not.toHaveBeenCalled()
  })

  it('invalidates late callbacks after identity replacement', () => {
    const callbacks: (() => void)[] = []
    const terminate = vi.fn()
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe: () => true,
      terminate,
      now: () => 0,
      setTimer: (callback) => {
        callbacks.push(callback)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    const first = {}
    const replacement = {}
    watchdog.start(first)
    watchdog.probeNow(first)
    watchdog.start(replacement)
    callbacks.forEach((callback) => callback())
    expect(terminate).not.toHaveBeenCalled()
  })

  it('terminates immediately when a probe cannot be written', () => {
    const terminate = vi.fn()
    const identity = {}
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe: () => false,
      terminate
    })
    watchdog.start(identity)
    watchdog.probeNow(identity)
    expect(terminate).toHaveBeenCalledWith(identity)
  })
  function backgroundableFixture() {
    const sendProbe = vi.fn(() => true)
    const terminate = vi.fn()
    const identity = {}
    const state = { foreground: true }
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'relay',
      sendProbe,
      terminate,
      shouldIdleProbe: () => state.foreground,
      now: Date.now
    })
    watchdog.start(identity)
    return { identity, sendProbe, state, terminate, watchdog }
  }

  it('stops retrying an idle probe once the app backgrounds under it', async () => {
    const { sendProbe, state, terminate } = backgroundableFixture()
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS)
    expect(sendProbe).toHaveBeenCalledOnce()

    // iOS suspends the socket in the background, so every further miss is evidence
    // about the app and not about the peer. Retrying would spend the whole budget on
    // the suspension and terminate a relay that is fine.
    state.foreground = false
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS * 4)
    expect(sendProbe).toHaveBeenCalledOnce()
    expect(terminate).not.toHaveBeenCalled()
  })

  it('re-arms the idle sweep with a clean slate after a backgrounded probe', async () => {
    const { sendProbe, state, terminate } = backgroundableFixture()
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS)
    state.foreground = false
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS)
    state.foreground = true

    // The abandoned probe must not be carried forward as a miss: the sweep needs its
    // full three fair misses again before it may call the session dead.
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS)
    expect(sendProbe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS * 2)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS)
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('gives a resume probe its own miss budget, not the one the ordinary probe spent', async () => {
    // Why: the urgent profile exists to tolerate one slow answer from a cold radio. Inheriting
    // an ordinary miss spends that tolerance before the resume probe is even sent, so the first
    // slow answer on a healthy socket kills the session -- the case the profile was added for.
    const terminate = vi.fn()
    const sendProbe = vi.fn(() => true)
    const identity = {}
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'relay',
      idleProbeMs: 20_000,
      probeTimeoutMs: 4_000,
      missedProbeLimit: 2,
      urgentProbeTimeoutMs: 2_000,
      urgentMissedProbeLimit: 2,
      shouldIdleProbe: () => true,
      sendProbe,
      terminate,
      now: Date.now
    })
    watchdog.start(identity)

    // One ordinary miss on the idle sweep, tolerated, and a second ordinary probe in flight.
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(terminate).not.toHaveBeenCalled()

    // Foreground: the resume probe supersedes the ordinary one still in flight.
    watchdog.probeNow(identity, 'resume')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(terminate).not.toHaveBeenCalled()

    // The second urgent miss is the one that may terminate.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('still reaches a verdict on a caller probe when the app backgrounds', async () => {
    // The gate covers the idle sweep only. A nudge or resume probe was asked for on
    // purpose, and abandoning it would leave a genuinely dead socket unreported.
    const { identity, state, terminate, watchdog } = backgroundableFixture()
    watchdog.probeNow(identity)
    state.foreground = false

    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS * 3)
    expect(terminate).toHaveBeenCalledOnce()
  })
})
