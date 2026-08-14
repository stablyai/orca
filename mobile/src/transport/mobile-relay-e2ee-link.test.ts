import { describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: {
    create: () => ({})
  }
}))

vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEV2PhysicalChannel: class {
    start = vi.fn()
    handleMessage = vi.fn(async () => {})
    sendText = vi.fn(() => true)
    sendBinary = vi.fn(() => true)
    dispose = vi.fn()
  }
}))

import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'

class ThrowingSocket {
  static readonly OPEN = 1
  readonly OPEN = ThrowingSocket.OPEN
  readyState = ThrowingSocket.OPEN
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  send = vi.fn(() => {
    throw new Error('relay auth write failed')
  })
  close = vi.fn()
}

describe('MobileRelayE2eeLink', () => {
  it('routes the initial relay-auth write exception through link failure', () => {
    const socket = new ThrowingSocket()
    const onError = vi.fn()
    new MobileRelayE2eeLink({
      endpoint: {
        cellUrl: 'https://relay-c1.onorca.dev',
        relayHostId: 'AbCdEf0123_-xyZ9'
      },
      credential: 'credential',
      expectedCredentialKind: 'resume',
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'desktop-key',
      onAuthenticated: vi.fn(),
      onText: vi.fn(),
      onBinary: vi.fn(),
      onError,
      createSocket: () => socket as unknown as WebSocket
    })

    expect(() => socket.onopen?.()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay auth write failed' })
    )
    expect(socket.close).toHaveBeenCalledOnce()
  })
})
