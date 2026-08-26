import { describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile Relay director credential fallback', () => {
  it('uses grace when the director rejects the current resume credential', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(
      (_relay, credential: { version: number }) =>
        new FakeRelaySession(
          credential.version === bundle.current.version ? 'disconnected' : 'connected',
          credential.version === bundle.current.version ? new RelayOuterError(4409) : null
        )
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      resolveRelay: ({ relay, resumeToken }) =>
        resolveMobileRelayEndpoint({
          relay,
          resumeToken,
          fetchImpl: vi.fn(async () => new Response('', { status: 401 }))
        })
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(openRelay.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ version: 1 }))
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })
})
