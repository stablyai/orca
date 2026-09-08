import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type RpcClient } from './rpc-client'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

// Capability ordering has dedicated coverage; keep disposal tests focused on stream teardown.
vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

class ServerSubscriptionTestSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = ServerSubscriptionTestSocket.CONNECTING
  readonly OPEN = ServerSubscriptionTestSocket.OPEN
  readonly CLOSING = ServerSubscriptionTestSocket.CLOSING
  readonly CLOSED = ServerSubscriptionTestSocket.CLOSED

  readyState = ServerSubscriptionTestSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(readonly endpoint: string) {
    sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = ServerSubscriptionTestSocket.CLOSED
    this.onclose?.()
  }

  open(): void {
    this.readyState = ServerSubscriptionTestSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

type SentRequest = { id: string; method: string; params?: unknown }

const sockets: ServerSubscriptionTestSocket[] = []
const originalWebSocket = globalThis.WebSocket

function sentRequests(socket: ServerSubscriptionTestSocket, method: string): SentRequest[] {
  return socket.sent
    .map((payload) => JSON.parse(payload.replace(/^encrypted:/, '')) as SentRequest)
    .filter((request) => request.method === method)
}

function connectReadyClient(): { client: RpcClient; socket: ServerSubscriptionTestSocket } {
  const client = connect('ws://desktop.invalid', 'token', 'server-key')
  const socket = sockets[0]!
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
  return { client, socket }
}

function emitReady(
  socket: ServerSubscriptionTestSocket,
  requestId: string,
  subscriptionId: string
): void {
  socket.receive(
    `encrypted:${JSON.stringify({
      id: requestId,
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId },
      _meta: { runtimeId: 'r1' }
    })}`
  )
}

describe('server subscription stream disposal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    globalThis.WebSocket = ServerSubscriptionTestSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('unsubscribes a stream disposed after ready', () => {
    const { client, socket } = connectReadyClient()
    const unsubscribe = client.subscribe('runtime.clientEvents.subscribe', null, () => {})
    const request = sentRequests(socket, 'runtime.clientEvents.subscribe')[0]!
    emitReady(socket, request.id, 'runtime-events:test')

    unsubscribe()

    expect(sentRequests(socket, 'runtime.clientEvents.unsubscribe')).toEqual([
      expect.objectContaining({ params: { subscriptionId: 'runtime-events:test' } })
    ])
    client.close()
  })

  it('keeps a tombstone and unsubscribes a stream disposed before ready', () => {
    const { client, socket } = connectReadyClient()
    const listener = vi.fn()
    const unsubscribe = client.subscribe('runtime.clientEvents.subscribe', null, listener)
    const request = sentRequests(socket, 'runtime.clientEvents.subscribe')[0]!

    unsubscribe()
    emitReady(socket, request.id, 'runtime-events:late')

    expect(listener).not.toHaveBeenCalled()
    expect(sentRequests(socket, 'runtime.clientEvents.unsubscribe')).toEqual([
      expect.objectContaining({ params: { subscriptionId: 'runtime-events:late' } })
    ])
    client.close()
  })

  it('unwatches a file stream disposed after ready', () => {
    const { client, socket } = connectReadyClient()
    const unsubscribe = client.subscribe('files.watch', { worktree: 'id:workspace-1' }, () => {})
    const request = sentRequests(socket, 'files.watch')[0]!
    emitReady(socket, request.id, 'files-watch-mobile-1')

    unsubscribe()

    expect(sentRequests(socket, 'files.unwatch')).toEqual([
      expect.objectContaining({ params: { subscriptionId: 'files-watch-mobile-1' } })
    ])
    client.close()
  })

  it('unsubscribes an accounts stream disposed after ready', () => {
    const { client, socket } = connectReadyClient()
    const unsubscribe = client.subscribe('accounts.subscribe', null, () => {})
    const request = sentRequests(socket, 'accounts.subscribe')[0]!
    emitReady(socket, request.id, 'accounts-mobile-1')

    unsubscribe()

    expect(sentRequests(socket, 'accounts.unsubscribe')).toEqual([
      expect.objectContaining({ params: { subscriptionId: 'accounts-mobile-1' } })
    ])
    client.close()
  })

  it('keeps a file-watch tombstone until a late ready can be unwatched', () => {
    const { client, socket } = connectReadyClient()
    const listener = vi.fn()
    const unsubscribe = client.subscribe('files.watch', { worktree: 'id:workspace-1' }, listener)
    const request = sentRequests(socket, 'files.watch')[0]!

    unsubscribe()
    emitReady(socket, request.id, 'files-watch-mobile-late')

    expect(listener).not.toHaveBeenCalled()
    expect(sentRequests(socket, 'files.unwatch')).toEqual([
      expect.objectContaining({ params: { subscriptionId: 'files-watch-mobile-late' } })
    ])
    client.close()
  })
})
