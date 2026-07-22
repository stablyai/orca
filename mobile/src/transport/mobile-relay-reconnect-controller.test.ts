import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('relay reconnect controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one retry timer and cancels it when recovery needs an external signal', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new RelayOuterError(4429))
    reconnect.registerFailure(new RelayOuterError(4408))
    expect(vi.getTimerCount()).toBe(1)

    reconnect.registerFailure(new RelayOuterError(4404))
    expect(vi.getTimerCount()).toBe(0)
    expect(reconnect.shouldDefer()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(onRetry).not.toHaveBeenCalled()
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

  it('waits for an external signal after rejected E2EE authentication', () => {
    const onRetry = vi.fn()
    const reconnect = createController(onRetry)

    reconnect.registerFailure(new MobileE2EEAuthenticationError())

    expect(reconnect.shouldDefer()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(onRetry).not.toHaveBeenCalled()
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
