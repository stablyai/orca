import WebSocket from 'ws'
import { encrypt } from '../../shared/e2ee-crypto'
import type { PairingOffer } from '../../shared/pairing'

export type RpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

type PendingRpcRequest = {
  resolve: (result: RpcResult) => void
  reject: (error: Error) => void
}

const REQUEST_TIMEOUT_MS = 15_000

export type PeerClientRpcChannelDeps = {
  getWs: () => WebSocket | null
  getSharedKey: () => Uint8Array | null
  getOffer: () => PairingOffer | null
  getHandshakeState: () => 'awaiting_ready' | 'awaiting_auth' | 'ready'
  nextCounter: () => number
}

// Why: encrypted request/response layer shared by RPC calls and stream
// subscribe messages — owns the pending-map bookkeeping so callers just await.
export class PeerClientRpcChannel {
  private readonly pending = new Map<string, PendingRpcRequest>()

  constructor(private readonly deps: PeerClientRpcChannelDeps) {}

  sendEncrypted(payload: unknown): boolean {
    const ws = this.deps.getWs()
    const sharedKey = this.deps.getSharedKey()
    if (!ws || ws.readyState !== WebSocket.OPEN || !sharedKey) {
      return false
    }
    ws.send(encrypt(JSON.stringify(payload), sharedKey))
    return true
  }

  sendRequest(method: string, params: unknown): Promise<RpcResult> {
    const offer = this.deps.getOffer()
    if (!offer || this.deps.getHandshakeState() !== 'ready') {
      return Promise.reject(new Error('Not connected to a peer host'))
    }
    const deviceToken = offer.deviceToken
    const id = `peer-${this.deps.nextCounter()}-${Date.now()}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      if (!this.sendEncrypted({ id, deviceToken, method, params })) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new Error('Connection interrupted'))
      }
    })
  }

  // Why: resolves a pending sendRequest() call if `id` matches one; returns
  // false so callers can fall through to other id-keyed handlers otherwise.
  resolve(id: string, message: { ok: boolean; result?: unknown; error?: unknown }): boolean {
    const pending = this.pending.get(id)
    if (!pending) {
      return false
    }
    this.pending.delete(id)
    pending.resolve(
      message.ok
        ? { ok: true, result: message.result }
        : { ok: false, error: message.error as { code: string; message: string } }
    )
    return true
  }

  rejectAll(error: Error): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id)
      request.reject(error)
    }
  }
}
