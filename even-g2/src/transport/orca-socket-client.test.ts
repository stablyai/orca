import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { OrcaSocketClient, type WebSocketLike } from './orca-socket-client'
import {
  deriveSharedKey,
  decryptText,
  encryptText,
  publicKeyFromBase64,
  publicKeyToBase64
} from './glasses-e2ee'
import type { ConnectionState } from './orca-rpc-wire'

// A tiny fake server responder that speaks the real E2EE handshake (spec S6), so
// OrcaSocketClient is exercised end-to-end without touching Unit 6's sim/mock-orca-server.
// Two FakeSockets are peered so send() on one delivers to the other's onmessage via a
// microtask, mirroring how a real WebSocket delivers asynchronously.

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  binaryType?: string
  closed = false
  peer: FakeSocket | null = null

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.closed) {
      throw new Error('socket is closed')
    }
    const peer = this.peer
    if (peer) {
      queueMicrotask(() => {
        if (!peer.closed) {
          peer.onmessage?.({ data })
        }
      })
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    queueMicrotask(() => this.onclose?.(undefined))
  }
}

type RpcHandlerResult =
  | { result: unknown; streaming?: true }
  | { error: { code: string; message: string } }
  | null
  | 'ignore'

class FakeOrcaServer {
  readonly socket = new FakeSocket()
  readonly receivedRpcCalls: { id: string; method: string; params: unknown }[] = []
  responder: (method: string, params: unknown, id: string) => RpcHandlerResult = () => null
  private sharedKey: Uint8Array | null = null
  private authenticated = false

  constructor(
    private readonly serverKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
    private readonly expectedDeviceToken: string
  ) {
    this.socket.onmessage = (event) => this.handleMessage(event.data)
  }

  pushEncryptedText(payload: unknown): void {
    if (!this.sharedKey) {
      return
    }
    this.socket.send(encryptText(JSON.stringify(payload), this.sharedKey))
  }

  pushEncryptedBinary(payload: Uint8Array): void {
    if (!this.sharedKey) {
      return
    }
    const nonce = nacl.randomBytes(nacl.box.nonceLength)
    const ciphertext = nacl.box.after(payload, nonce, this.sharedKey)
    const bundle = new Uint8Array(nonce.length + ciphertext.length)
    bundle.set(nonce)
    bundle.set(ciphertext, nonce.length)
    this.socket.send(bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength))
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return
    }
    if (!this.sharedKey) {
      let hello: { type?: unknown; publicKeyB64?: unknown }
      try {
        hello = JSON.parse(data)
      } catch {
        return
      }
      if (hello.type === 'e2ee_hello' && typeof hello.publicKeyB64 === 'string') {
        const clientPublicKey = publicKeyFromBase64(hello.publicKeyB64)
        this.sharedKey = deriveSharedKey(this.serverKeyPair.secretKey, clientPublicKey)
        this.socket.send(JSON.stringify({ type: 'e2ee_ready' }))
      }
      return
    }
    const plaintext = decryptText(data, this.sharedKey)
    if (plaintext === null) {
      return
    }
    let message: {
      type?: unknown
      id?: unknown
      deviceToken?: unknown
      method?: unknown
      params?: unknown
    }
    try {
      message = JSON.parse(plaintext)
    } catch {
      return
    }
    if (!this.authenticated) {
      if (message.type === 'e2ee_auth') {
        if (message.deviceToken === this.expectedDeviceToken) {
          this.authenticated = true
          this.pushEncryptedText({ type: 'e2ee_authenticated' })
        } else {
          this.pushEncryptedText({
            id: '',
            ok: false,
            error: { code: 'unauthorized', message: 'bad token' },
            _meta: { runtimeId: 'fake' }
          })
        }
      }
      return
    }
    if (typeof message.id === 'string' && typeof message.method === 'string') {
      this.receivedRpcCalls.push({ id: message.id, method: message.method, params: message.params })
      this.handleRpc(message.id, message.method, message.params)
    }
  }

  private handleRpc(id: string, method: string, params: unknown): void {
    const handled = this.responder(method, params, id)
    if (handled === 'ignore') {
      return
    }
    if (handled === null) {
      this.pushEncryptedText({ id, ok: true, result: {}, _meta: { runtimeId: 'fake' } })
      return
    }
    if ('error' in handled) {
      this.pushEncryptedText({ id, ok: false, error: handled.error, _meta: { runtimeId: 'fake' } })
      return
    }
    this.pushEncryptedText({
      id,
      ok: true,
      result: handled.result,
      streaming: handled.streaming,
      _meta: { runtimeId: 'fake' }
    })
  }
}

function createHarness(deviceToken: string, opts?: { failFirstAttempts?: number }) {
  const serverKeyPair = nacl.box.keyPair()
  const servers: FakeOrcaServer[] = []
  const sockets: FakeSocket[] = []
  let attempt = 0

  const socketFactory = (_url: string): WebSocketLike => {
    attempt += 1
    const server = new FakeOrcaServer(serverKeyPair, deviceToken)
    const clientSocket = new FakeSocket()
    clientSocket.peer = server.socket
    server.socket.peer = clientSocket
    servers.push(server)
    sockets.push(clientSocket)
    if (opts?.failFirstAttempts && attempt <= opts.failFirstAttempts) {
      // Simulate a connection that dies before the handshake completes (e.g. host unreachable).
      queueMicrotask(() => clientSocket.onclose?.(undefined))
    } else {
      queueMicrotask(() => clientSocket.onopen?.(undefined))
    }
    return clientSocket
  }

  return {
    socketFactory,
    servers,
    sockets,
    serverPublicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OrcaSocketClient', () => {
  it('completes the handshake and resolves a request/response round trip', async () => {
    const harness = createHarness('token-1')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory
    })
    harness.servers[0]!.responder = (method) =>
      method === 'status.get' ? { result: { protocolVersion: 3 } } : null

    await flushMicrotasks()
    expect(client.getState()).toBe('connected')

    const response = await client.sendRequest('status.get')
    expect(response.ok).toBe(true)
    expect(response.ok && response.result).toEqual({ protocolVersion: 3 })
  })

  it('rejects sendRequest once the timeout elapses with no response', async () => {
    const harness = createHarness('token-1')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory
    })
    await flushMicrotasks()
    harness.servers[0]!.responder = () => 'ignore'

    await expect(client.sendRequest('silent.method', undefined, 20)).rejects.toThrow(/timed out/)
  })

  it('reconnects with increasing backoff (1s, 2s, 4s, ...) across consecutive failures', async () => {
    vi.useFakeTimers()
    // First 3 connection attempts die before the handshake completes (host unreachable), so the
    // backoff schedule keeps escalating instead of resetting on a successful reconnect.
    const harness = createHarness('token-1', { failFirstAttempts: 3 })
    const states: ConnectionState[] = []
    new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory,
      onState: (s) => states.push(s)
    })
    await flushMicrotasks()
    expect(harness.sockets).toHaveLength(1)
    expect(states.at(-1)).toBe('reconnecting')

    vi.advanceTimersByTime(999)
    expect(harness.sockets).toHaveLength(1)
    vi.advanceTimersByTime(1) // 1s elapsed -> 2nd attempt
    await flushMicrotasks()
    expect(harness.sockets).toHaveLength(2)
    expect(states.at(-1)).toBe('reconnecting')

    vi.advanceTimersByTime(1999)
    expect(harness.sockets).toHaveLength(2)
    vi.advanceTimersByTime(1) // 2s more elapsed -> 3rd attempt
    await flushMicrotasks()
    expect(harness.sockets).toHaveLength(3)
    expect(states.at(-1)).toBe('reconnecting')

    vi.advanceTimersByTime(3999)
    expect(harness.sockets).toHaveLength(3)
    vi.advanceTimersByTime(1) // 4s more elapsed -> 4th attempt, which succeeds
    await flushMicrotasks()
    expect(harness.sockets).toHaveLength(4)
    expect(states.at(-1)).toBe('connected')
  })

  it('latches auth-failed on an unauthorized device token and never retries', async () => {
    const harness = createHarness('correct-token')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'wrong-token',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory
    })
    await flushMicrotasks()
    expect(client.getState()).toBe('auth-failed')
    expect(harness.sockets).toHaveLength(1)

    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    await flushMicrotasks()
    expect(harness.sockets).toHaveLength(1) // no reconnect storm

    await expect(client.sendRequest('status.get')).rejects.toThrow(/Authentication failed/)
  })

  it('re-sends active subscriptions after a reconnect + re-authentication', async () => {
    vi.useFakeTimers()
    const harness = createHarness('token-1')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory
    })
    await flushMicrotasks()

    const events: unknown[] = []
    client.subscribe('notifications.subscribe', { since: 0 }, (result) => events.push(result))
    await flushMicrotasks()
    expect(
      harness.servers[0]!.receivedRpcCalls.some((c) => c.method === 'notifications.subscribe')
    ).toBe(true)

    harness.sockets[0]!.onclose?.(undefined)
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(harness.servers).toHaveLength(2)
    expect(
      harness.servers[1]!.receivedRpcCalls.some((c) => c.method === 'notifications.subscribe')
    ).toBe(true)
  })

  it('unsubscribing a terminal.subscribe stream sends terminal.unsubscribe with subscriptionId = the original terminal id', async () => {
    const harness = createHarness('token-1')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory
    })
    await flushMicrotasks()
    harness.servers[0]!.responder = (method) =>
      method === 'terminal.subscribe'
        ? { result: { type: 'subscribed', streamId: 42 }, streaming: true }
        : null

    const unsubscribe = client.subscribe(
      'terminal.subscribe',
      { terminal: 'term-123', viewport: { cols: 60, rows: 20 } },
      () => {}
    )
    await flushMicrotasks()

    unsubscribe()
    await flushMicrotasks()

    const call = harness.servers[0]!.receivedRpcCalls.find(
      (c) => c.method === 'terminal.unsubscribe'
    )
    expect(call?.params).toEqual({ subscriptionId: 'term-123' })
  })

  it('routes decrypted binary terminal frames to the matching subscription onBinary callback', async () => {
    const { TerminalStreamOpcode, encodeTerminalStreamFrame } =
      await import('@orca-shared/terminal-stream-protocol')
    const harness = createHarness('token-1')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory
    })
    await flushMicrotasks()
    harness.servers[0]!.responder = (method) =>
      method === 'terminal.subscribe'
        ? { result: { type: 'subscribed', streamId: 7 }, streaming: true }
        : null

    const binaryPayloads: Uint8Array[] = []
    client.subscribe(
      'terminal.subscribe',
      { terminal: 'term-abc', viewport: { cols: 60, rows: 20 } },
      () => {},
      (payload) => binaryPayloads.push(payload)
    )
    await flushMicrotasks()

    const frameBytes = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: 7,
      seq: 1,
      payload: new TextEncoder().encode('hello')
    })
    harness.servers[0]!.pushEncryptedBinary(frameBytes)
    await flushMicrotasks()

    expect(binaryPayloads).toHaveLength(1)
    const decoded = binaryPayloads[0]!
    expect(new TextDecoder().decode(decoded.slice(16))).toBe('hello')
  })

  it('times out and reconnects when the socket never opens', async () => {
    vi.useFakeTimers()
    // A fake socket that never fires onopen/onmessage/onclose — the "never progresses" case.
    class StuckSocket implements WebSocketLike {
      onopen: ((event: unknown) => void) | null = null
      onmessage: ((event: { data: unknown }) => void) | null = null
      onclose: ((event: unknown) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      binaryType?: string
      closed = false
      send(): void {}
      close(): void {
        this.closed = true
      }
    }
    const stuckSockets: StuckSocket[] = []
    const states: ConnectionState[] = []
    new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: publicKeyToBase64(nacl.box.keyPair().publicKey),
      connectTimeoutMs: 5000,
      socketFactory: () => {
        const s = new StuckSocket()
        stuckSockets.push(s)
        return s
      },
      onState: (s) => states.push(s)
    })
    await flushMicrotasks()
    // 'connecting' is the client's initial state, so no onState fires for it — only the
    // eventual timeout-driven transition is observable here.
    expect(states).toEqual([])

    vi.advanceTimersByTime(4999)
    expect(states).toEqual([])
    vi.advanceTimersByTime(1)
    await flushMicrotasks()

    expect(stuckSockets[0]!.closed).toBe(true)
    expect(states.at(-1)).toBe('reconnecting')
  })

  it('times out and reconnects when the socket opens but the peer never completes the handshake', async () => {
    vi.useFakeTimers()
    const harness = createHarness('token-1')
    // Sever the peer link right after creation so e2ee_hello is sent into the void — the socket
    // opens (handshaking starts) but no e2ee_ready ever arrives.
    const socketFactory = (url: string): WebSocketLike => {
      const socket = harness.socketFactory(url) as FakeSocket
      socket.peer = null
      return socket
    }
    const states: ConnectionState[] = []
    new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      handshakeTimeoutMs: 5000,
      socketFactory,
      onState: (s) => states.push(s)
    })
    await flushMicrotasks()
    expect(states.at(-1)).toBe('handshaking')

    vi.advanceTimersByTime(4999)
    expect(states.at(-1)).toBe('handshaking')
    vi.advanceTimersByTime(1)
    await flushMicrotasks()

    expect(harness.sockets[0]!.closed).toBe(true)
    expect(states.at(-1)).toBe('reconnecting')
  })

  it('does not double-send a request created by a connected listener during bootstrap replay', async () => {
    const harness = createHarness('token-1')
    const client = new OrcaSocketClient({
      endpoint: 'ws://test',
      deviceToken: 'token-1',
      serverPublicKeyB64: harness.serverPublicKeyB64,
      socketFactory: harness.socketFactory,
      onState: (state) => {
        if (state === 'connected') {
          // A listener reacting to 'connected' synchronously issues a new request; it must be
          // sent exactly once, not once immediately and again by the bootstrap replay loop.
          client.sendRequest('extra.method').catch(() => {})
        }
      }
    })
    harness.servers[0]!.responder = (method) => (method === 'extra.method' ? { result: {} } : null)

    await flushMicrotasks()

    const extraCalls = harness.servers[0]!.receivedRpcCalls.filter(
      (c) => c.method === 'extra.method'
    )
    expect(extraCalls).toHaveLength(1)
  })
})
