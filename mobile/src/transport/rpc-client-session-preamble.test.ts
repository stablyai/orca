import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connect } from './rpc-client'
import { scopeRpcClientToExecutionHost } from './execution-host-scoped-rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

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

vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }

  drop(): void {
    this.close()
    this.onclose?.()
  }
}

const mockSockets: MockWebSocket[] = []

const WireFrame = z.looseObject({ method: z.string().optional(), params: z.unknown() })

// Handshake frames are not request objects; they parse to null.
function parseFrame(payload: string): z.infer<typeof WireFrame> | null {
  return WireFrame.safeParse(JSON.parse(payload.replace(/^encrypted:/, ''))).data ?? null
}

/** The socket's request frames after the handshake, in wire order. */
function wire(socket: MockWebSocket): { method: string; params?: unknown }[] {
  return socket.sent.flatMap((payload) => {
    const frame = parseFrame(payload)
    return frame?.method ? [{ method: frame.method, params: frame.params }] : []
  })
}

function connectAuthenticated(): { client: ReturnType<typeof connect>; socket: MockWebSocket } {
  const client = connect('ws://desktop.invalid', 'token', 'server-key')
  const socket = mockSockets[mockSockets.length - 1]!
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
  return { client, socket }
}

const VIEW = 'sidebarInputs.reportView'
const AWAY = { workspaceIds: [], tabIds: [], presentForMs: 0 }
const SHOWS_B = { workspaceIds: ['b'], tabIds: [], presentForMs: null }

function authenticate(socket: MockWebSocket): void {
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
}

// The host reads a phone's re-subscribed session as on screen unless it already holds the view.
describe('session preamble', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('goes out before a subscription made while connecting, unlike a request', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    void client.sendRequest('status.get').catch(() => {})
    client.subscribe('session.tabs.subscribe', { worktree: 'id:a' }, () => {})
    client.setSessionPreamble?.(VIEW, VIEW, AWAY)
    const socket = mockSockets[0]!
    authenticate(socket)
    expect(wire(socket).map((frame) => frame.method)).toEqual([VIEW, 'session.tabs.subscribe'])
    client.close()
  })

  it('is sent at once while connected, ahead of a subscription that follows it', () => {
    const { client, socket } = connectAuthenticated()
    client.setSessionPreamble?.(VIEW, VIEW, AWAY)
    client.subscribe('session.tabs.subscribe', { worktree: 'id:a' }, () => {})
    expect(wire(socket).map((frame) => frame.method)).toEqual([VIEW, 'session.tabs.subscribe'])
    client.close()
  })

  it('leads every reconnected session with its latest value', () => {
    const { client, socket } = connectAuthenticated()
    client.setSessionPreamble?.(VIEW, VIEW, AWAY)
    client.subscribe('session.tabs.subscribe', { worktree: 'id:a' }, () => {})
    client.setSessionPreamble?.(VIEW, VIEW, SHOWS_B)
    socket.drop()
    vi.advanceTimersByTime(30_000)
    const next = mockSockets[mockSockets.length - 1]!
    expect(next).not.toBe(socket)
    authenticate(next)
    expect(wire(next)).toEqual([
      { method: VIEW, params: SHOWS_B },
      { method: 'session.tabs.subscribe', params: { worktree: 'id:a' } }
    ])
    client.close()
  })

  it('leads a migrated session, before the logical client replays its subscriptions', async () => {
    const lan = connectAuthenticated()
    const client = createStableLogicalRpcClient(lan.client, 'relay')
    client.setSessionPreamble?.(VIEW, VIEW, SHOWS_B)
    client.subscribe('session.tabs.subscribe', { worktree: 'id:a' }, () => {})
    const replacement = connectAuthenticated()
    await client.migrateTo(replacement.client, 'lan')
    expect(wire(replacement.socket)).toEqual([
      { method: VIEW, params: SHOWS_B },
      { method: 'session.tabs.subscribe', params: { worktree: 'id:a' } }
    ])
    client.close()
  })

  it('keeps one preamble per server a scoped view names, each with its envelope', () => {
    const { client, socket } = connectAuthenticated()
    client.setSessionPreamble?.(VIEW, VIEW, AWAY)
    scopeRpcClientToExecutionHost(client, 'runtime:hub').setSessionPreamble?.(VIEW, VIEW, SHOWS_B)
    socket.drop()
    vi.advanceTimersByTime(30_000)
    const next = mockSockets[mockSockets.length - 1]!
    authenticate(next)
    const frames = next.sent.map(parseFrame)
    expect(frames.filter((frame) => frame?.method === VIEW)).toEqual([
      expect.objectContaining({ params: AWAY }),
      expect.objectContaining({ params: SHOWS_B, executionHost: 'runtime:hub' })
    ])
    client.close()
  })
})
