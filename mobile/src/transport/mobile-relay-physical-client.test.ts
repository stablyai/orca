import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  channelOptions: null as null | {
    onAuthenticated(): void
    onText(value: string): void
  },
  start: vi.fn(),
  handleMessage: vi.fn(),
  sendText: vi.fn(() => true),
  dispose: vi.fn()
}))

vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: vi.fn(() => ({ hello: {} })) }
}))
vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
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

import { connectMobileRelayForPairing, RelayOuterError } from './mobile-relay-physical-client'
import type { ConnectionLogEntry } from './types'

class FakeSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  send(value: unknown): void {
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
    vi.clearAllMocks()
    fakes.channelOptions = null
    fakes.sendText.mockReturnValue(true)
  })

  it('uses first-frame outer auth, waits for host attach, then carries RPC over E2EE v2', async () => {
    const socket = new FakeSocket()
    let openedUrl = ''
    const client = connectMobileRelayForPairing({
      relay,
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createSocket: (url) => {
        openedUrl = url
        return socket as unknown as WebSocket
      }
    })
    socket.onopen?.()
    expect(openedUrl).toBe('wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9')
    expect(openedUrl).not.toContain('?')
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'relay-auth',
      v: 1,
      mode: 'connect',
      credential: relay.inviteToken
    })

    socket.receive(
      JSON.stringify({
        type: 'relay-hello',
        ok: true,
        credentialKind: 'invite',
        leaseExpiresAt: Date.now() + 60_000
      })
    )
    await vi.waitFor(() => expect(fakes.start).toHaveBeenCalledOnce())
    fakes.channelOptions!.onAuthenticated()
    const responsePromise = client.sendRequest('status.get')
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const request = JSON.parse(fakes.sendText.mock.calls[0]![0] as string)
    expect(request).toEqual({
      id: 'relay-pair-1',
      deviceToken: 'device-token',
      method: 'status.get'
    })
    fakes.channelOptions!.onText(
      JSON.stringify({
        id: request.id,
        ok: true,
        result: { path: 'relay' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    await expect(responsePromise).resolves.toMatchObject({ ok: true, result: { path: 'relay' } })
  })

  it('surfaces a typed endpoint-scoped outer rejection before E2EE', async () => {
    const socket = new FakeSocket()
    const client = connectMobileRelayForPairing({
      relay,
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createSocket: () => socket as unknown as WebSocket
    })
    const status = client.sendRequest('status.get')
    socket.receive(JSON.stringify({ type: 'relay-hello', ok: false, code: 4404 }))

    await expect(status).rejects.toEqual(new RelayOuterError(4404))
    expect(fakes.start).not.toHaveBeenCalled()
  })

  it('narrates dial, outer auth, handshake and authentication without leaking the invite', async () => {
    const socket = new FakeSocket()
    const entries: ConnectionLogEntry[] = []
    const client = connectMobileRelayForPairing({
      relay,
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createSocket: () => socket as unknown as WebSocket,
      onLog: (entry) => entries.push(entry)
    })
    socket.onopen?.()
    socket.receive(
      JSON.stringify({
        type: 'relay-hello',
        ok: true,
        credentialKind: 'invite',
        leaseExpiresAt: Date.now() + 60_000
      })
    )
    await vi.waitFor(() => expect(fakes.start).toHaveBeenCalledOnce())
    fakes.channelOptions!.onAuthenticated()
    client.close()

    expect(entries.map((entry) => `${entry.level}|${entry.message}|${entry.detail}`)).toEqual([
      'info|Relay: dialing cell|relay-c1.onorca.dev',
      'info|Relay: cell socket open|Sending relay credential',
      'info|Relay: cell accepted credential|Starting E2EE handshake',
      'success|Relay: authenticated|Channel ready for RPC',
      'info|Relay: pairing socket closed|relay-c1.onorca.dev'
    ])
    expect(JSON.stringify(entries)).not.toContain(relay.inviteToken)
  })

  it('logs the relay close code when the cell rejects the credential', async () => {
    const socket = new FakeSocket()
    const entries: ConnectionLogEntry[] = []
    const client = connectMobileRelayForPairing({
      relay,
      deviceToken: 'device-token',
      desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createSocket: () => socket as unknown as WebSocket,
      onLog: (entry) => entries.push(entry)
    })
    const status = client.sendRequest('status.get')
    socket.receive(JSON.stringify({ type: 'relay-hello', ok: false, code: 4404 }))

    await expect(status).rejects.toEqual(new RelayOuterError(4404))
    expect(entries.at(-1)).toMatchObject({
      level: 'warn',
      message: 'Relay: pairing socket closed',
      detail: 'relay close code 4404'
    })
  })
})
