import type { RpcResponse, RpcSuccess, ConnectionState } from './types'
import {
  generateKeyPair,
  deriveSharedKey,
  publicKeyFromBase64,
  publicKeyToBase64,
  encrypt,
  decrypt
} from './e2ee'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type StreamingListener = (result: unknown) => void

type StreamRequest = {
  method: string
  params: unknown
  listener: StreamingListener
}

export type RpcClient = {
  sendRequest: (method: string, params?: unknown) => Promise<RpcResponse>
  subscribe: (method: string, params: unknown, onData: StreamingListener) => () => void
  getState: () => ConnectionState
  // Why: UI escalates "Reconnecting…" to "Can't connect" once attempts cross
  // a threshold. 0 means never failed; counter is reset on successful open.
  getReconnectAttempt: () => number
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  close: () => void
}

// Why: capped at 4s so the worst-case "stuck reconnecting" window the
// user perceives is short. Prior 16s ceiling combined with Android's
// suspended-timer behaviour during background → foreground transitions
// often felt like the app would just sit on 'Reconnecting…' forever
// (the timer was queued, the OS had simply not run it yet). Tapping the
// manual Reconnect button bypassed the timer, which is why it felt
// "magic". Shorter backoff makes the auto-recovery path feel as fast.
const RECONNECT_DELAYS = [500, 1000, 2000, 4000]
const REQUEST_TIMEOUT_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 5_000

export function connect(
  endpoint: string,
  deviceToken: string,
  serverPublicKeyB64: string,
  onStateChange?: (state: ConnectionState) => void
): RpcClient {
  let ws: WebSocket | null = null
  let state: ConnectionState = 'disconnected'
  let requestCounter = 0
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let intentionallyClosed = false

  // Why: fresh ephemeral keypair per connection provides forward secrecy.
  // The shared key is derived from our ephemeral secret + server's static public key.
  let sharedKey: Uint8Array | null = null
  const serverPublicKey = publicKeyFromBase64(serverPublicKeyB64)

  const pending = new Map<string, PendingRequest>()
  const streamListeners = new Map<string, StreamRequest>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const connectWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []

  if (onStateChange) {
    stateListeners.add(onStateChange)
  }

  function setState(next: ConnectionState) {
    if (state === next) return
    state = next
    if (next === 'connected') {
      for (const w of connectWaiters.splice(0)) w.resolve()
    } else if (next === 'disconnected' || next === 'auth-failed') {
      const reason =
        next === 'auth-failed' ? 'Unauthorized — pairing may be revoked' : 'Connection closed'
      for (const w of connectWaiters.splice(0)) w.reject(new Error(reason))
    }
    for (const listener of stateListeners) {
      listener(next)
    }
  }

  function waitForConnected(): Promise<void> {
    if (state === 'connected') return Promise.resolve()
    if (intentionallyClosed) return Promise.reject(new Error('Client closed'))
    return new Promise((resolve, reject) => {
      connectWaiters.push({ resolve, reject })
    })
  }

  function nextId(): string {
    return `rpc-${++requestCounter}-${Date.now()}`
  }

  function openConnection() {
    if (intentionallyClosed) return

    setState('connecting')
    sharedKey = null

    ws = new WebSocket(endpoint)

    ws.onopen = () => {
      reconnectAttempt = 0
      setState('handshaking')

      // Why: generate a fresh ephemeral keypair for each connection.
      // This provides forward secrecy — compromising one session's key
      // doesn't compromise past or future sessions.
      const ephemeral = generateKeyPair()
      const hello = JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(ephemeral.publicKey)
      })
      ws?.send(hello)

      sharedKey = deriveSharedKey(ephemeral.secretKey, serverPublicKey)

      handshakeTimer = setTimeout(() => {
        handshakeTimer = null
        ws?.close()
      }, HANDSHAKE_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)

      // Why: during handshaking, e2ee_ready is plaintext because it precedes
      // encrypted auth; e2ee_authenticated/e2ee_error are encrypted.
      if (state === 'handshaking') {
        try {
          const msg = JSON.parse(raw)
          if (msg.type === 'e2ee_ready') {
            sendEncrypted({ type: 'e2ee_auth', deviceToken })
            return
          }
        } catch {
          // Not plaintext JSON — fall through and try encrypted handshake messages.
        }

        if (!sharedKey || sharedKey.length !== 32) {
          return
        }

        const plaintext = decrypt(raw, sharedKey)
        if (plaintext === null) {
          return
        }

        try {
          const msg = JSON.parse(plaintext)
          if (msg.type === 'e2ee_authenticated') {
            if (handshakeTimer) {
              clearTimeout(handshakeTimer)
              handshakeTimer = null
            }
            setState('connected')
            for (const [id, stream] of streamListeners) {
              sendEncrypted({ id, deviceToken, method: stream.method, params: stream.params })
            }
          } else if (msg.type === 'e2ee_error' || (!msg.ok && msg.error?.code === 'unauthorized')) {
            intentionallyClosed = true
            ws?.close()
            ws = null
            setState('auth-failed')
            rejectAllPending('Unauthorized — pairing may be revoked')
          }
        } catch {
          // Not JSON — ignore during handshake.
        }
        return
      }

      // Why: guard against decrypt with an invalid key — sharedKey can be null
      // after destroy() or if a message arrives during a reconnect race.
      if (!sharedKey || sharedKey.length !== 32) {
        return
      }

      const plaintext = decrypt(raw, sharedKey)
      if (plaintext === null) {
        return
      }

      let response: RpcResponse
      try {
        response = JSON.parse(plaintext)
      } catch {
        return
      }

      // Why: auth failure is distinct from transient disconnect — retrying
      // with a rejected token causes infinite reconnect churn.
      if (!response.ok && response.error.code === 'unauthorized') {
        intentionallyClosed = true
        ws?.close()
        ws = null
        setState('auth-failed')
        rejectAllPending('Unauthorized — pairing may be revoked')
        return
      }

      const isStreaming = response.ok && (response as RpcSuccess).streaming === true

      if (isStreaming) {
        const stream = streamListeners.get(response.id)
        if (stream && response.ok) {
          stream.listener((response as RpcSuccess).result)
        }
        return
      }

      if (response.ok) {
        const result = (response as RpcSuccess).result as Record<string, unknown> | null
        if (result && result.type === 'end') {
          const stream = streamListeners.get(response.id)
          if (stream) {
            stream.listener(result)
            streamListeners.delete(response.id)
            return
          }
        }
        if (result && result.type === 'scrollback') {
          const stream = streamListeners.get(response.id)
          if (stream) {
            stream.listener(result)
            return
          }
        }
      }

      const req = pending.get(response.id)
      if (req) {
        pending.delete(response.id)
        req.resolve(response)
      }
    }

    ws.onclose = () => {
      ws = null
      sharedKey = null
      if (handshakeTimer) {
        clearTimeout(handshakeTimer)
        handshakeTimer = null
      }
      if (intentionallyClosed) {
        setState('disconnected')
        rejectAllPending('Connection closed')
        return
      }
      rejectAllPending('Connection interrupted')
      setState('reconnecting')
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose will fire after this
    }
  }

  function scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openConnection()
    }, delay)
  }

  function rejectAllPending(reason: string) {
    const error = new Error(reason)
    for (const [id, req] of pending) {
      pending.delete(id)
      queueMicrotask(() => req.reject(error))
    }
  }

  function sendEncrypted(request: unknown): boolean {
    if (ws && ws.readyState === WebSocket.OPEN && sharedKey) {
      ws.send(encrypt(JSON.stringify(request), sharedKey))
      return true
    }
    return false
  }

  openConnection()

  return {
    async sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
      await waitForConnected()

      return new Promise((resolve, reject) => {
        const id = nextId()
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Request timed out: ${method}`))
        }, REQUEST_TIMEOUT_MS)

        pending.set(id, {
          resolve: (response) => {
            clearTimeout(timeout)
            resolve(response)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          }
        })

        if (!sendEncrypted({ id, deviceToken, method, params })) {
          pending.delete(id)
          clearTimeout(timeout)
          reject(new Error('Connection interrupted'))
        }
      })
    },

    subscribe(method: string, params: unknown, onData: StreamingListener): () => void {
      const id = nextId()
      streamListeners.set(id, { method, params, listener: onData })

      if (state === 'connected') {
        sendEncrypted({ id, deviceToken, method, params })
      }

      return () => {
        const stream = streamListeners.get(id)
        streamListeners.delete(id)
        if (
          stream?.method === 'terminal.subscribe' &&
          stream.params &&
          typeof stream.params === 'object' &&
          typeof (stream.params as { terminal?: unknown }).terminal === 'string'
        ) {
          // Why: the runtime registers cleanup under the composite key
          // `${terminal}:${clientId}` so two phones subscribing to the same
          // terminal handle don't evict each other. Echo that composite key
          // back on unsubscribe; also include `client.id` so the server can
          // reconstruct it if a stale build emits a bare-handle id. See
          // docs/mobile-presence-lock.md.
          const subscribeParams = stream.params as {
            terminal: string
            client?: { id?: string }
          }
          const clientId =
            typeof subscribeParams.client?.id === 'string' ? subscribeParams.client.id : undefined
          const subscriptionId = clientId
            ? `${subscribeParams.terminal}:${clientId}`
            : subscribeParams.terminal
          sendEncrypted({
            id: nextId(),
            deviceToken,
            method: 'terminal.unsubscribe',
            params: {
              subscriptionId,
              ...(clientId ? { client: { id: clientId } } : {})
            }
          })
        }
      }
    },

    getState(): ConnectionState {
      return state
    },

    getReconnectAttempt(): number {
      return reconnectAttempt
    },

    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },

    close() {
      intentionallyClosed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (handshakeTimer) {
        clearTimeout(handshakeTimer)
        handshakeTimer = null
      }
      if (ws) {
        ws.close()
        ws = null
      }
      sharedKey = null
      setState('disconnected')
      rejectAllPending('Client closed')
    }
  }
}
