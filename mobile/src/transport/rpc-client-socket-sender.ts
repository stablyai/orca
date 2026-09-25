import { createWsOutboundBackpressureQueue } from '../../../src/shared/ws-outbound-backpressure-queue'
import { encrypt, encryptBytes } from './e2ee'
import type { ConnectionState } from './types'

type SocketSenderOptions = {
  claimQueuedBytes?: (bytes: number) => (() => void) | null
  socket: WebSocket
  getKey: () => Uint8Array | null
  isAuthenticated: () => boolean
  getCurrentSocket: () => WebSocket | null
  getState: () => ConnectionState
  forceClose: () => void
}

export class RpcClientSocketSender {
  private readonly binaryQueue = createWsOutboundBackpressureQueue<Uint8Array>({
    send: (bytes) => {
      const key = this.options.getKey()
      if (!key) {
        throw new Error('Binary channel is closed')
      }
      this.options.socket.send(encryptBytes(bytes, key))
    },
    claimQueuedBytes: (bytes) =>
      this.options.claimQueuedBytes ? this.options.claimQueuedBytes(bytes) : () => {},
    byteLengthOf: (bytes) => bytes.byteLength + 40,
    getBufferedAmount: () => this.options.socket.bufferedAmount,
    isWritable: () =>
      this.options.isAuthenticated() &&
      !!this.options.getKey() &&
      this.options.socket.readyState === WebSocket.OPEN,
    onOverflow: () => this.options.forceClose()
  })

  constructor(private readonly options: SocketSenderOptions) {}

  sendEncrypted(request: unknown): boolean {
    const key = this.options.getKey()
    if (this.options.socket.readyState === WebSocket.OPEN && key) {
      try {
        this.options.socket.send(encrypt(JSON.stringify(request), key))
        return true
      } catch {
        if (this.options.getCurrentSocket() === this.options.socket) {
          this.options.forceClose()
        }
        return false
      }
    }
    console.log('[net] sendEncrypted FAILED — channel not ready', {
      hasWs: this.options.getCurrentSocket() !== null,
      readyState: this.options.socket.readyState,
      hasKey: this.options.getKey() !== null,
      state: this.options.getState()
    })
    if (
      this.options.getState() === 'connected' &&
      this.options.getCurrentSocket() === this.options.socket &&
      this.options.socket.readyState !== WebSocket.OPEN
    ) {
      console.log('[net] sendEncrypted detected ws desync — forcing reconnect', {
        readyState: this.options.socket.readyState
      })
      this.options.forceClose()
    }
    return false
  }

  sendBinary(bytes: Uint8Array): boolean {
    return (
      this.options.isAuthenticated() &&
      !!this.options.getKey() &&
      this.options.socket.readyState === WebSocket.OPEN &&
      this.binaryQueue.enqueue(bytes.slice())
    )
  }

  dispose(): void {
    this.binaryQueue.dispose()
  }
}

export function sendDirectRpcRequest(
  session: { sendEncrypted: (request: unknown) => boolean } | null,
  state: ConnectionState,
  request: unknown
): boolean {
  if (session) {
    return session.sendEncrypted(request)
  }
  console.log('[net] sendEncrypted FAILED — channel not ready', {
    hasWs: false,
    hasKey: false,
    state
  })
  return false
}
