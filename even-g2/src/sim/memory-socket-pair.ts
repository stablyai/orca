// Unit 6: in-memory WebSocket-shaped pair (spec S6) so MockOrcaServer can speak the real E2EE
// wire to an in-process "client" without a real socket/port — works identically in the browser
// (sim.html) and in vitest/node.

export const MEMORY_SOCKET_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const

/** The subset of the WebSocket surface OrcaSocketClient (Unit 3) touches. */
export type MemorySocketLike = {
  readyState: number
  binaryType: 'blob' | 'arraybuffer'
  onopen: (() => void) | null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data
  }
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return view.slice().buffer
}

class MemorySocketEndpoint implements MemorySocketLike {
  readyState: number = MEMORY_SOCKET_READY_STATE.CONNECTING
  // Real browsers default to 'blob'; this mock always delivers ArrayBuffer for binary
  // frames regardless of this flag (documented simplification — callers should set
  // 'arraybuffer', which every real OrcaSocketClient usage does).
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private peer: MemorySocketEndpoint | null = null

  linkPeer(peer: MemorySocketEndpoint): void {
    this.peer = peer
  }

  open(): void {
    if (this.readyState !== MEMORY_SOCKET_READY_STATE.CONNECTING) {
      return
    }
    this.readyState = MEMORY_SOCKET_READY_STATE.OPEN
    this.onopen?.()
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== MEMORY_SOCKET_READY_STATE.OPEN) {
      throw new Error('memory socket: send() called before open or after close')
    }
    const peer = this.peer
    if (!peer) {
      return
    }
    const payload: string | ArrayBuffer = typeof data === 'string' ? data : toArrayBuffer(data)
    queueMicrotask(() => {
      if (peer.readyState === MEMORY_SOCKET_READY_STATE.OPEN) {
        peer.onmessage?.({ data: payload })
      }
    })
  }

  close(code?: number, reason?: string): void {
    if (
      this.readyState === MEMORY_SOCKET_READY_STATE.CLOSED ||
      this.readyState === MEMORY_SOCKET_READY_STATE.CLOSING
    ) {
      return
    }
    this.readyState = MEMORY_SOCKET_READY_STATE.CLOSING
    const peer = this.peer
    // Deferred (not synchronous) so a send() issued just before close() — e.g. an
    // "unauthorized" error preceding socket teardown — is still in the microtask queue
    // ahead of this callback and is delivered before the peer flips to CLOSED.
    queueMicrotask(() => {
      this.readyState = MEMORY_SOCKET_READY_STATE.CLOSED
      this.onclose?.({ code, reason })
      if (peer && peer.readyState !== MEMORY_SOCKET_READY_STATE.CLOSED) {
        peer.readyState = MEMORY_SOCKET_READY_STATE.CLOSED
        peer.onclose?.({ code, reason })
      }
    })
  }
}

export type MemorySocketPair = {
  /** Client-side handle: what a `socketFactory` injection point hands to OrcaSocketClient. */
  clientSocket: MemorySocketLike
  /** Server-side handle: what MockOrcaServer attaches to. */
  serverSocket: MemorySocketLike
}

/** Creates a linked client/server socket pair that opens asynchronously (microtask), mirroring
 *  real WebSocket's CONNECTING -> OPEN transition. */
export function createMemorySocketPair(): MemorySocketPair {
  const client = new MemorySocketEndpoint()
  const server = new MemorySocketEndpoint()
  client.linkPeer(server)
  server.linkPeer(client)
  queueMicrotask(() => {
    client.open()
    server.open()
  })
  return { clientSocket: client, serverSocket: server }
}
