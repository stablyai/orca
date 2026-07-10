// Why: shared WebSocket test double for the rpc-client test files. Kept out of
// the spec files so each suite stays under the max-lines lint budget.
import { vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'

export class MockWebSocket {
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
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  emitCloseOnClose = true
  sent: (string | ArrayBuffer)[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    if (this.emitCloseOnClose) {
      this.onclose?.()
    }
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string | ArrayBuffer): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

export const mockSockets: MockWebSocket[] = []

export function authenticateMockSocket(socket: MockWebSocket): void {
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
}

export function receiveTerminalSubscribed(
  socket: MockWebSocket,
  requestId: string,
  streamId?: number
): void {
  socket.receive(
    `encrypted:${JSON.stringify({
      id: requestId,
      ok: true,
      streaming: true,
      result: streamId === undefined ? { type: 'subscribed' } : { type: 'subscribed', streamId }
    })}`
  )
}

export function subscribeTerminalStream(
  client: RpcClient,
  socket: MockWebSocket,
  terminal: string,
  streamId?: number
): void {
  client.subscribe('terminal.subscribe', { terminal }, () => {})
  receiveTerminalSubscribed(socket, sentRequest(socket, 'terminal.subscribe').id, streamId)
}

export function sentRequest(
  socket: MockWebSocket,
  method: string
): { id: string; params?: unknown } {
  const [first] = sentRequests(socket, method)
  if (!first) {
    throw new Error(`Request not sent: ${method}`)
  }
  return first
}

export function sentRequests(
  socket: MockWebSocket,
  method: string
): Array<{ id: string; params?: unknown }> {
  const requests: Array<{ id: string; params?: unknown }> = []
  for (const payload of socket.sent) {
    if (typeof payload !== 'string') {
      continue
    }
    const decoded = JSON.parse(payload.replace(/^encrypted:/, '')) as {
      id: string
      method: string
      params?: unknown
    }
    if (decoded.method === method) {
      requests.push({ id: decoded.id, params: decoded.params })
    }
  }
  return requests
}

export function encodeBrowserFrame(): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({ deviceWidth: 800, deviceHeight: 600 }))
  const image = new Uint8Array([1, 2, 3, 4])
  const out = new Uint8Array(16 + metadata.byteLength + image.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, 0x62)
  view.setUint8(1, 1)
  view.setUint8(2, 1)
  view.setUint8(3, 1)
  view.setUint32(4, 7, true)
  view.setUint32(8, metadata.byteLength, true)
  view.setUint32(12, 0, true)
  out.set(metadata, 16)
  out.set(image, 16 + metadata.byteLength)
  return out
}

export function encodeTerminalOutput(streamId: number, chunk: string): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId,
    seq: 1,
    payload: new TextEncoder().encode(chunk)
  })
}
