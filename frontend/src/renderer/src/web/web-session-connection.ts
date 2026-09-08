// WebSocket connect/reconnect state machine for WebSessionClient — split out
// of web-session-client.ts to keep that file under oxlint's max-lines budget.
// This class owns the socket, connection state, and reconnect backoff only;
// request/subscription bookkeeping (the `pending`/`subscriptions` maps) stays
// on WebSessionClient, which is notified through these constructor callbacks
// instead of this class reaching back into it.
import { REQUEST_TIMEOUT_MS, type WebRuntimeConnectionState } from './web-session-client-protocol'

const CONNECT_TIMEOUT_MS = 12_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]

export type WebSessionConnectionCallbacks = {
  onMessage: (rawData: unknown) => void
  // Why: `new WebSocket(url)` can throw synchronously (e.g. malformed URL);
  // that failure must still reject WebSessionClient's in-flight `pending`
  // requests, which this class doesn't own.
  onConnectError: (message: string) => void
  // Why: fired once the connection has already transitioned to 'auth-failed'
  // and closed its socket — either from a 1008/3000/4401 close code, or from
  // WebSessionClient calling forceAuthFailed() after spotting an `unauthorized`
  // RPC error inside a message. WebSessionClient owns the dispatch/reject/
  // notify side effects that follow.
  onAuthFailed: () => void
  onInterrupted: () => void
}

export class WebSessionConnection {
  private ws: WebSocket | null = null
  private state: WebRuntimeConnectionState = 'disconnected'
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private connectTimer: number | null = null
  private reconnectTimer: number | null = null
  private readonly waiters: { resolve: () => void; reject: (error: Error) => void }[] = []

  constructor(
    private readonly endpoint: string,
    private readonly callbacks: WebSessionConnectionCallbacks
  ) {
    this.open()
  }

  getState(): WebRuntimeConnectionState {
    return this.state
  }

  send(message: unknown): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(`${JSON.stringify(message)}\n`)
    return true
  }

  waitForConnected(timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    if (this.state === 'connected') {
      return Promise.resolve()
    }
    if (this.state === 'auth-failed') {
      return Promise.reject(new Error('Unauthorized. Session cookie may have expired.'))
    }
    if (this.intentionallyClosed) {
      return Promise.reject(new Error('Remote Orca runtime connection closed.'))
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index !== -1) {
          this.waiters.splice(index, 1)
        }
        reject(new Error('Timed out while connecting to the remote Orca runtime.'))
      }, timeoutMs)
      this.waiters.push({
        resolve: () => {
          window.clearTimeout(timeout)
          resolve()
        },
        reject: (error) => {
          window.clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  // Why: called by WebSessionClient when it detects an `unauthorized` RPC
  // error inside a message payload. The close-code path (1008/3000/4401)
  // reaches auth-failed on its own via handleSocketClosed below.
  forceAuthFailed(): void {
    this.intentionallyClosed = true
    this.setState('auth-failed')
    this.ws?.close()
  }

  close(): void {
    this.intentionallyClosed = true
    this.clearTimers()
    this.rejectAllWaiters(new Error('Remote Orca runtime connection closed.'))
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  private open(): void {
    if (this.intentionallyClosed) {
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(this.endpoint)
    } catch (error) {
      this.callbacks.onConnectError(error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }

    this.ws = ws
    this.setState('connecting')

    this.connectTimer = window.setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close()
        this.handleSocketClosed(ws)
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.ws !== ws) {
        return
      }
      this.clearConnectTimer()
      this.reconnectAttempt = 0
      this.setState('connected')
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) {
        return
      }
      this.callbacks.onMessage(event.data)
    }

    ws.onclose = (event) => this.handleSocketClosed(ws, event)
    ws.onerror = () => {
      if (this.state === 'connecting') {
        this.rejectAllWaiters(new Error('Could not connect to the remote Orca runtime.'))
      }
    }
  }

  private handleSocketClosed(closedWs: WebSocket, event?: CloseEvent): void {
    if (this.ws !== closedWs) {
      return
    }
    this.ws = null
    this.clearConnectTimer()
    this.clearKeepaliveTimer()

    // Handle session expiry or unauthorized disconnect from backend
    // FIX TASK-TRM-007: Also handle code 4401 (WsSessionRouter sends this for missing/expired session).
    // 1008: WebSocket protocol "Policy Violation"
    // 3000: Legacy Orca session expired
    // 4401: WsSessionRouter unauthenticated (no valid session cookie)
    if (event && (event.code === 1008 || event.code === 3000 || event.code === 4401)) {
      this.intentionallyClosed = true
      this.setState('auth-failed')
      this.callbacks.onAuthFailed()
      return
    }

    this.callbacks.onInterrupted()
    if (this.intentionallyClosed || this.state === 'auth-failed') {
      this.setState(this.state === 'auth-failed' ? 'auth-failed' : 'disconnected')
      return
    }
    this.setState('disconnected')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) {
      return
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private setState(next: WebRuntimeConnectionState): void {
    this.state = next
    if (next === 'connected') {
      for (const waiter of this.waiters.splice(0)) {
        waiter.resolve()
      }
    } else if (next === 'auth-failed') {
      this.rejectAllWaiters(new Error('Unauthorized. Session cookie may have expired.'))
    }
  }

  private rejectAllWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      window.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  // Why: handleSocketClosed calls this to cancel any pending keepalive/heartbeat
  // timer. WebSessionClient uses a simpler connection model without a dedicated
  // keepalive loop (cookie-auth sessions rely on the server-side session TTL
  // instead), so this is a no-op stub kept for symmetry with WebRuntimeClient.
  private clearKeepaliveTimer(): void {
    // no-op: this client has no keepalive timer
  }
}
