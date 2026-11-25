import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  FakeLogicalClient,
  FakeRelaySession,
  bundle,
  dependencies,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'

vi.mock('../../host-credentials/pairing-keychain', () => ({
  deletePairingKeychainItem: vi.fn(),
  readPairingKeychainItem: vi.fn(),
  writePairingKeychainItem: vi.fn()
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

describe('direct-grace race queued behind relay recovery', () => {
  afterEach(() => vi.useRealTimers())

  it('dials Relay once an operation that skipped its dial releases the mutex', async () => {
    vi.useFakeTimers()
    // Off the home network: the direct client is redialing a Tailscale address that never answers.
    const logical = new FakeLogicalClient('reconnecting', 'tailscale')
    let releaseKeychain: (value: MobileRelayCredentialBundle) => void = () => {}
    const readBundle = vi
      .fn<() => Promise<MobileRelayCredentialBundle | null>>()
      // The cold-start read misses, so recovery re-reads the keychain under the mutex.
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(
        () => new Promise<MobileRelayCredentialBundle>((resolve) => (releaseKeychain = resolve))
      )
      .mockResolvedValue(bundle)
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ readBundle, openRelay, directPath: 'tailscale' })
    )

    try {
      const started = supervisor.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(readBundle).toHaveBeenCalledTimes(2)
      // The direct client starts its next dial while the keychain read is pending.
      logical.publishState('connecting')
      // Direct grace elapses and queues a forced race behind the in-flight recovery.
      await vi.advanceTimersByTimeAsync(2_500)
      releaseKeychain(bundle)
      await started
      await vi.advanceTimersByTimeAsync(0)

      expect(openRelay).toHaveBeenCalledTimes(1)
      expect(logical.getActivePath()).toBe('relay')
      expect(logical.getState()).toBe('connected')
    } finally {
      supervisor.stop()
    }
  })
})
