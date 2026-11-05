// Pin diagnostic clocks and auth-failed latches when RN omits close and later delivers the stale event.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { connect } from './rpc-client'
import { PAIRED_E2EE_HANDSHAKE_DEADLINE_MS } from '../../../src/shared/remote-runtime/e2ee/paired-e2ee-handshake-deadline'

import { recordSocketDeadlineAppState } from './socket-deadline-clock'

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

// Model a wedged native socket whose close() emits no onclose.
class WedgedWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = WedgedWebSocket.CONNECTING
  readonly OPEN = WedgedWebSocket.OPEN
  readonly CLOSING = WedgedWebSocket.CLOSING
  readonly CLOSED = WedgedWebSocket.CLOSED

  readyState = WedgedWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    this.readyState = WedgedWebSocket.CLOSED
  })

  constructor(readonly endpoint: string) {
    sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = WedgedWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }

  // Deliver the delayed native close after the client’s own fallback.
  deliverClose(code: number, reason = ''): void {
    this.readyState = WedgedWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: true })
  }
}

const sockets: WedgedWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function lastSocket(): WedgedWebSocket {
  return sockets[sockets.length - 1]!
}

describe('synthesized close diagnostics', () => {
  let logSpy: MockInstance<typeof console.log>

  beforeEach(() => {
    vi.useFakeTimers()
    recordSocketDeadlineAppState('active')
    sockets.length = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This socket fixture supplies the constructor, states, handlers, send and close consumed by the real client.
    globalThis.WebSocket = WedgedWebSocket as unknown as typeof WebSocket
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('still latches auth-failed when a real 4001 lands after a synthesized close', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const wedged = lastSocket()
    wedged.open()
    await vi.advanceTimersByTimeAsync(PAIRED_E2EE_HANDSHAKE_DEADLINE_MS)
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    const replacement = lastSocket()

    // The rejection counts, but stale cleanup must not disturb the replacement or its timer path.
    wedged.deliverClose(4001, 'Unauthorized')
    expect(lastSocket()).toBe(replacement)
    expect(replacement.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sockets).toHaveLength(2)
    expect(lastSocket()).toBe(replacement)
    expect(client.getState()).toBe('connecting')

    for (let rejection = 0; rejection < 2; rejection += 1) {
      const socket = lastSocket()
      socket.open()
      socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
      socket.deliverClose(4001, 'Unauthorized')
      if (rejection === 0) {
        await vi.advanceTimersByTimeAsync(2_500)
      }
    }

    expect(client.getState()).toBe('auth-failed')
    expect(sockets).toHaveLength(3)

    const dialCount = sockets.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sockets).toHaveLength(dialCount)
    expect(client.getState()).toBe('auth-failed')

    client.close()
  })

  it('ignores a stale 4001 after the replacement authenticates', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const wedged = lastSocket()
    wedged.open()
    await vi.advanceTimersByTimeAsync(PAIRED_E2EE_HANDSHAKE_DEADLINE_MS + 500)

    const replacement = lastSocket()
    replacement.open()
    replacement.receive(JSON.stringify({ type: 'e2ee_ready' }))
    replacement.receive('encrypted:{"type":"e2ee_authenticated"}')
    expect(client.getState()).toBe('connected')

    wedged.deliverClose(4001, 'Unauthorized')
    expect(client.getState()).toBe('connected')
    expect(replacement.close).not.toHaveBeenCalled()

    for (let rejection = 0; rejection < 2; rejection += 1) {
      const socket = lastSocket()
      socket.deliverClose(4001, 'Unauthorized')
      expect(client.getState()).toBe('reconnecting')
      await vi.advanceTimersByTimeAsync(rejection === 0 ? 500 : 1_000)
      lastSocket().open()
      lastSocket().receive(JSON.stringify({ type: 'e2ee_ready' }))
    }

    lastSocket().deliverClose(4001, 'Unauthorized')
    expect(client.getState()).toBe('auth-failed')

    client.close()
  })
})
