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

  it('keeps a typed close code when transport error precedes close', () => {
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

    socket.onerror?.()
    socket.onclose?.({ code: 4409 })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'relay_outer_4409' }))
  })

  it('classifies an opaque close after transport error as 1006', () => {
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

    socket.onerror?.()
    socket.onclose?.({ code: 0 })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'relay_outer_1006' }))
  })

  it('bounds an error when the platform never emits close', async () => {
    vi.useFakeTimers()
    try {
      const socket = new ThrowingSocket()
      const onError = vi.fn()
      const link = new MobileRelayE2eeLink({
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
      socket.onerror?.()
      await vi.advanceTimersByTimeAsync(250)

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'relay_outer_1006' }))
      link.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the missing-close timer when explicitly closed', async () => {
    vi.useFakeTimers()
    try {
      const socket = new ThrowingSocket()
      const onError = vi.fn()
      const link = new MobileRelayE2eeLink({
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
      socket.onerror?.()
      link.close()
      await vi.advanceTimersByTimeAsync(250)

      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
