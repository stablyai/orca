import { describe, expect, it, vi } from 'vitest'
import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

describe('MobileRelayE2eeLink', () => {
  it('rejects a malformed saved desktop key before opening any socket', () => {
    const createSocket = vi.fn<(url: string) => WebSocket>()
    expect(
      () =>
        new MobileRelayE2eeLink({
          endpoint: { cellUrl: 'https://c1.relay.example', relayHostId: 'host-1' },
          credential: 'resume-token',
          expectedCredentialKind: 'resume',
          deviceToken: 'device-token',
          desktopPublicKeyB64: 'not a key',
          onAuthenticated: () => {},
          onText: () => {},
          onBinary: () => {},
          onError: () => {},
          createSocket
        })
    ).toThrow()
    // A socket built before the throw would never be closed, and every retry would leak another.
    expect(createSocket).not.toHaveBeenCalled()
  })
})
