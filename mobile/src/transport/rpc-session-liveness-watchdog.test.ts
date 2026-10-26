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
    let callback: (() => void) | undefined
    const terminate = vi.fn()
    const sendProbe = vi.fn(() => true)
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'relay',
      idleProbeMs: null,
      probeTimeoutMs: 4_000,
      missedProbeLimit: 2,
      sendProbe,
      terminate,
      now: () => now,
      setTimer: (next) => {
        callback = next
        return setTimeout(() => {}, 0)
      },
      clearTimer: () => {}
    })
    const identity = {}
    watchdog.start(identity)
    watchdog.probeNow(identity)
    expect(sendProbe).toHaveBeenCalledOnce()
    if (!callback) {
      throw new Error('Expected a scheduled probe deadline')
    }
    now = 8_000
    callback()
    expect(sendProbe).toHaveBeenCalledTimes(2)
    now += 4_000
    callback()
    expect(sendProbe).toHaveBeenCalledTimes(3)
    expect(terminate).not.toHaveBeenCalled()
    now += 4_000
    callback()
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledWith(identity)
  })

  it('invalidates late callbacks after identity replacement', () => {
    const callbacks: (() => void)[] = []
    const terminate = vi.fn()
    const sendProbe = vi.fn(() => true)
    let now = 0
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe,
      terminate,
      now: () => now,
      setTimer: (callback) => {
        callbacks.push(callback)
        return setTimeout(() => {}, 0)
      },
      clearTimer: () => {}
    })
    const first = {}
    const replacement = {}
    watchdog.start(first)
    watchdog.probeNow(first)
    expect(callbacks).toHaveLength(2)
    const staleCallbacks = [...callbacks]
    watchdog.start(replacement)
    expect(callbacks).toHaveLength(3)
    now = 20_000
    staleCallbacks.forEach((callback) => callback())
    expect(sendProbe).toHaveBeenCalledOnce()
    expect(callbacks).toHaveLength(3)
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

  it('ends the session on the first miss of a decisive probe', async () => {
    const { identity, sendProbe, terminate, watchdog } = fixture()
    watchdog.probeNow(identity, 3_000)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(terminate).toHaveBeenCalledOnce()
    expect(sendProbe).toHaveBeenCalledOnce()
  })

  it('keeps a decisive probe alive when it is answered', async () => {
    const { identity, terminate, watchdog } = fixture()
    watchdog.probeNow(identity, 3_000)
    await vi.advanceTimersByTimeAsync(1_000)
    watchdog.noteAuthenticatedInbound(identity)

    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS - 1)
    expect(terminate).not.toHaveBeenCalled()
  })
})
