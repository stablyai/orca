import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  FakeLogicalClient,
  FakeRelaySession,
  dependencies,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'

vi.mock('../../host-credentials/pairing-keychain', () => ({
  deletePairingKeychainItem: vi.fn(),
  readPairingKeychainItem: vi.fn(),
  writePairingKeychainItem: vi.fn()
}))
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

describe('Relay credential recovery', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    {
      description: 'retries after a bare close',
      rejectedByRelayHello: false,
      expectedDials: 2,
      expected: 'connected'
    },
    {
      description: 'waits after an explicit refusal',
      rejectedByRelayHello: true,
      expectedDials: 1,
      expected: 'disconnected'
    }
  ])('$description', async ({ rejectedByRelayHello, expectedDials, expected }) => {
    vi.useFakeTimers()
    const logical = new FakeLogicalClient('disconnected', 'relay')
    const openRelay = vi
      .fn(() => new FakeRelaySession('connected'))
      .mockReturnValueOnce(
        new FakeRelaySession('disconnected', new RelayOuterError(4401, rejectedByRelayHello))
      )
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openRelay, directUnavailable: true })
    )

    try {
      await supervisor.start()
      // Covers the first transport backoff ceiling but stays under the credential-gate reprobe.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(openRelay).toHaveBeenCalledTimes(expectedDials)
      expect(logical.getState()).toBe(expected)
    } finally {
      supervisor.stop()
    }
  })
})
