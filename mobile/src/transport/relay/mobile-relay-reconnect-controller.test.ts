import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RelayReconnectController } from './mobile-relay-reconnect-controller'

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
      setTimer: (handler, ms) => setTimeout(handler, ms),
      clearTimer: (handle) => clearTimeout(handle)
    },
    onRetry
  )
  controller.reportRecoveryTo({
    setRecoveryAttempt: reportFailureCount,
    setPairingRejected: reportPairingRejected,
    setRelayHostReachability: () => {}
  })
  return controller
}
