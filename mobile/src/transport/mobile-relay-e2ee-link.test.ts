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

import { MOBILE_RELAY_PHONE_CLOSE_REASON } from '../../../src/shared/mobile-relay-close-codes'
import { MobileRelayE2eeLink, RelayOuterError } from './mobile-relay-e2ee-link'

class ThrowingSocket {
  static readonly OPEN = 1
  readonly OPEN = ThrowingSocket.OPEN
  readyState = ThrowingSocket.OPEN
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  send = vi.fn((_frame: string): void => {
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
      createSocket: () => relayWebSocket(socket)
    })

    expect(() => socket.onopen?.()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay auth write failed' })
    )
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('reports open only once relay-auth is on the wire', () => {
    const socket = new ThrowingSocket()
    const onOpen = vi.fn()
    const sent: string[] = []
    socket.send.mockImplementation((frame: string) => {
      sent.push(frame)
    })
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
      onOpen,
      onError: vi.fn(),
      createSocket: () => relayWebSocket(socket)
    })

    expect(onOpen).not.toHaveBeenCalled()
    socket.onopen?.()
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'relay-auth',
      v: 1,
      mode: 'connect',
      credential: 'credential'
    })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('does not report open when the relay-auth write fails', () => {
    const socket = new ThrowingSocket()
    const onOpen = vi.fn()
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
      onOpen,
      onError: vi.fn(),
      createSocket: () => relayWebSocket(socket)
    })

    socket.onopen?.()
    expect(onOpen).not.toHaveBeenCalled()
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
      createSocket: () => relayWebSocket(socket)
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
      createSocket: () => relayWebSocket(socket)
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
        createSocket: () => relayWebSocket(socket)
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
        createSocket: () => relayWebSocket(socket)
      })
      socket.onerror?.()
      expect(vi.getTimerCount()).toBe(1)
      link.close()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(250)

      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries the close reason of a relay-hello refusal that arrives first', async () => {
    vi.useFakeTimers()
    try {
      const socket = new ThrowingSocket()
      const onError = vi.fn()
      openLink(socket, onError)
      socket.onmessage?.({ data: JSON.stringify({ type: 'relay-hello', ok: false, code: 4404 }) })
      await vi.advanceTimersByTimeAsync(0)
      expect(onError).not.toHaveBeenCalled()

      socket.onclose?.({ code: 4404, reason: MOBILE_RELAY_PHONE_CLOSE_REASON.HOST_ATTACH_TIMEOUT })

      const error: unknown = onError.mock.calls[0]?.[0]
      expect(error).toBeInstanceOf(RelayOuterError)
      expect(error).toMatchObject({
        code: 4404,
        rejectedByRelayHello: true,
        closeReason: 'attach-timeout'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a relay-hello refusal whose close never arrives', async () => {
    vi.useFakeTimers()
    try {
      const socket = new ThrowingSocket()
      const onError = vi.fn()
      openLink(socket, onError)
      socket.onmessage?.({ data: JSON.stringify({ type: 'relay-hello', ok: false, code: 4404 }) })
      await vi.advanceTimersByTimeAsync(249)
      expect(onError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0]?.[0]).toMatchObject({
        code: 4404,
        rejectedByRelayHello: true,
        closeReason: ''
      })
      expect(socket.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

function openLink(socket: ThrowingSocket, onError: (error: Error) => void): MobileRelayE2eeLink {
  return new MobileRelayE2eeLink({
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
    createSocket: () => relayWebSocket(socket)
  })
}

function relayWebSocket(socket: ThrowingSocket): WebSocket {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The link and mocked channel only send/close and assign event handlers on this socket.
  return socket as unknown as WebSocket
}
