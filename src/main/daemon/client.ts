import { DaemonClientConnection } from './daemon-client-connection'
import { encodeNdjson } from './ndjson'
import { NOTIFY_PREFIX, DaemonConnectionLostError } from './types'
import { writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'
import { writeNotifyWithSettlement } from './daemon-client-notify-settlement'
import { requestDaemonRpc } from './daemon-client-rpc-request'
export type { DaemonClientOptions } from './daemon-client-connection'

const REQUEST_TIMEOUT_MS = 30000
const NOTIFY_SETTLEMENT_TIMEOUT_MS = 5000

export class DaemonClient extends DaemonClientConnection {
  private requestCounter = 0

  async request<T = unknown>(
    type: string,
    payload: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.connected || !this.controlSocket) {
      // No socket is a transport failure, distinct from a daemon refusing the request.
      throw new DaemonConnectionLostError('Not connected')
    }
    const generation = this.connectionGeneration

    return requestDaemonRpc<T>({
      socket: this.controlSocket,
      pendingRequests: this.pendingRequests,
      id: `req-${++this.requestCounter}`,
      type,
      payload,
      timeoutMs,
      ...(signal ? { signal } : {}),
      unmatchedCancelGraceMs: NOTIFY_SETTLEMENT_TIMEOUT_MS,
      onCreateCancellationFailure: () => this.handleDisconnect(generation),
      settleCreateCancellation: (sessionId, requestId) =>
        this.request<{ canceled: boolean }>(
          'cancelCreateOrAttach',
          { sessionId, requestId },
          NOTIFY_SETTLEMENT_TIMEOUT_MS
        )
    })
  }

  // Why: fire-and-forget writes need a local delivery signal to trigger dead-endpoint recovery.
  notify(type: string, payload: unknown): boolean {
    if (!this.connected || !this.controlSocket) {
      return false
    }

    const id = `${NOTIFY_PREFIX}${++this.requestCounter}`
    const msg = { id, type, ...(payload !== undefined ? { payload } : {}) }
    try {
      this.controlSocket.write(encodeNdjson(msg))
      return true
    } catch {
      // Notifications are best-effort; an oversized payload must not tear down the caller.
      return false
    }
  }

  async notifyWithSettlement(
    type: string,
    payload: unknown,
    timeoutMs = NOTIFY_SETTLEMENT_TIMEOUT_MS
  ): Promise<WriteSettlement> {
    if (!this.connected || !this.controlSocket) {
      return writeRefused('endpoint_disconnected')
    }

    const id = `${NOTIFY_PREFIX}${++this.requestCounter}`
    const socket = this.controlSocket
    const generation = this.connectionGeneration
    return await writeNotifyWithSettlement({
      socket,
      message: { id, type, ...(payload !== undefined ? { payload } : {}) },
      timeoutMs,
      onUndeliverable: () => {
        if (this.controlSocket === socket && this.connectionGeneration === generation) {
          this.handleDisconnect(generation)
        }
      }
    })
  }

  onEvent(listener: (event: unknown) => void): () => void {
    return this.eventListeners.add(listener)
  }

  onDisconnected(listener: () => void): () => void {
    return this.disconnectedListeners.add(listener)
  }
}
