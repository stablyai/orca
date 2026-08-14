import { vi } from 'vitest'

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
  sent: string[] = []
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
}

export const mockSockets: MockWebSocket[] = []
export const originalWebSocket = globalThis.WebSocket

export function sentRequest(
  socket: MockWebSocket,
  method: string
): { id: string; params?: unknown } {
  const request = sentRequests(socket, method)[0]
  if (!request) {
    throw new Error(`Request not sent: ${method}`)
  }
  return request
}

export function sentRequests(
  socket: MockWebSocket,
  method: string
): Array<{ id: string; params?: unknown }> {
  const requests: Array<{ id: string; params?: unknown }> = []
  for (const payload of socket.sent) {
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
