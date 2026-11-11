import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  channelOptions: null as null | {
    onAuthenticated(): void
    onText(value: string): void
  },
  start: vi.fn(),
  handleMessage: vi.fn(),
  sendText: vi.fn((_frame: string) => true),
  dispose: vi.fn()
}))

vi.mock('../transport/encryption/mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: vi.fn(() => ({ hello: {} })) }
}))
vi.mock('../transport/encryption/mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEV2PhysicalChannel: class {
    constructor(options: NonNullable<typeof fakes.channelOptions>) {
      fakes.channelOptions = options
    }
    start = fakes.start
    handleMessage = fakes.handleMessage
    sendText = fakes.sendText
    dispose = fakes.dispose
  }
}))

import { connectMobileRelayForPairing } from './mobile-relay-physical-client'
import { RelayOuterError } from '../transport/encryption/mobile-relay-e2ee-link'

class FakeSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {}

  receive(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
  inviteExpiresAt: Date.now() + 300_000,
  e2eeFraming: 2 as const
}

describe('mobile relay physical pairing client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    fakes.channelOptions = null
    fakes.sendText.mockReturnValue(true)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('surfaces a typed endpoint-scoped outer rejection before E2EE', async () => {
    const socket = new FakeSocket()
    const client = connectMobileRelayForPairing({
      relay,
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createSocket: () => pairingWebSocket(socket)
    })
    const status = client.sendRequest('status.get')
    socket.receive(JSON.stringify({ type: 'relay-hello', ok: false, code: 4404 }))

    await expect(status).rejects.toEqual(new RelayOuterError(4404, true))
    expect(fakes.start).not.toHaveBeenCalled()
  })

  it('keeps the typed close code when transport error precedes close', async () => {
    const socket = new FakeSocket()
    const client = connectMobileRelayForPairing({
      relay,
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createSocket: () => pairingWebSocket(socket)
    })
    const status = client.sendRequest('status.get')
    socket.onerror?.()
    socket.onclose?.({ code: 4409 })

    await expect(status).rejects.toEqual(new RelayOuterError(4409))
  })

  it('settles after an error when the platform never emits close', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const client = connectMobileRelayForPairing({
        relay,
        deviceToken: 'device-token',
        desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        createSocket: () => pairingWebSocket(socket)
      })
      const status = client.sendRequest('status.get')
      const rejected = expect(status).rejects.toEqual(new RelayOuterError(1006))
      socket.onerror?.()
      await vi.advanceTimersByTimeAsync(250)

      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})

function pairingWebSocket(socket: FakeSocket): WebSocket {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The client and mocked channel only send/close and assign event handlers on this socket.
  return socket as unknown as WebSocket
}
