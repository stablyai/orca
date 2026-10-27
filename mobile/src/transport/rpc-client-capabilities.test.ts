import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from './mobile-runtime-client-capabilities'

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

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSING = MockWebSocket.CLOSING
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

type SentRpcRequest = { id: string; method: string; params?: unknown }

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function sentRequest(socket: MockWebSocket, method: string): SentRpcRequest {
  const request = socket.sent
    .map((payload) => JSON.parse(payload.replace(/^encrypted:/, '')) as SentRpcRequest)
    .find((candidate) => candidate.method === method)
  if (!request) {
    throw new Error(`Request not sent: ${method}`)
  }
  return request
}

describe('mobile rpc-client capabilities', () => {
  beforeEach(() => {
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  it('waits for mobile capability acknowledgement before replaying streams', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    client.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, () => {})

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    const capabilityRequest = sentRequest(socket, 'runtime.clientCapabilities.update')
    expect(capabilityRequest.params).toMatchObject({
      clientCapabilities: expect.arrayContaining([
        'agent-session.structured.v1',
        'agent-session.pending-send-result.v1',
        'agent-session.structured.claude.v1',
        'agent-session.structured.hold.v1',
        'agent-session.turn-item.v1',
        'session-tabs.split-group-placement.v1',
        'agent-session.structured.registered-agents.v1',
        'agent-session.structured.pi-dialogs.v1',
        'agent-session.options.optional-model.v1',
        'agent.launch.v2',
        'agent.launch.unstarted-tab.v1',
        'agent.launch.tab-closed.v1'
      ])
    })
    expect(capabilityRequest.params).toEqual({
      clientCapabilities: [...MOBILE_RUNTIME_CLIENT_CAPABILITIES]
    })
    expect(socket.sent.some((payload) => payload.includes('session.tabs.subscribe'))).toBe(false)

    socket.receive(
      `encrypted:${JSON.stringify({
        id: capabilityRequest.id,
        ok: true,
        result: capabilityRequest.params,
        _meta: { runtimeId: 'runtime-1' }
      })}`
    )

    await vi.waitFor(() => expect(sentRequest(socket, 'session.tabs.subscribe')).toBeDefined())
    expect(client.getState()).toBe('connected')

    client.close()
  })

  it('replays streams when an older runtime rejects capability negotiation', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    client.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, () => {})

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    const capabilityRequest = sentRequest(socket, 'runtime.clientCapabilities.update')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: capabilityRequest.id,
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'runtime-1' }
      })}`
    )

    await vi.waitFor(() => expect(sentRequest(socket, 'session.tabs.subscribe')).toBeDefined())
    expect(client.getState()).toBe('connected')

    client.close()
  })

  it('reaches connected when a slow host never answers capability negotiation', async () => {
    vi.useFakeTimers()
    try {
      const client = connect('ws://desktop.invalid', 'token', 'server-key')
      const socket = mockSockets[0]!
      client.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, () => {})

      socket.open()
      socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
      socket.receive('encrypted:{"type":"e2ee_authenticated"}')
      sentRequest(socket, 'runtime.clientCapabilities.update')

      // An unanswered advisory must let slow links reach connected rather than repeatedly closing them.
      await vi.advanceTimersByTimeAsync(5_001)

      expect(client.getState()).toBe('connected')
      expect(sentRequest(socket, 'session.tabs.subscribe')).toBeDefined()
      expect(socket.readyState).toBe(MockWebSocket.OPEN)

      client.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
