import type {
  RpcResponse,
  RpcSuccess,
  ConnectionState,
  ConnectionLogLevel,
  ConnectionLogSink
} from './types'
import {
  generateKeyPair,
  deriveSharedKey,
  publicKeyFromBase64,
  publicKeyToBase64,
  encrypt,
  decrypt,
  decryptBytes
} from './e2ee'
import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from './rpc-client-terminal-binary-frame'
import {
  decodeBrowserScreencastFrame,
  type BrowserScreencastFrame
} from './browser-screencast-protocol'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport as updateCachedTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import { describeSocketEvent } from './socket-event-debug'
import { isRpcResponse } from './rpc-response-shape'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

type SendRequestOptions = {
  timeoutMs?: number
}

type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
}

type StreamingListener = (result: unknown) => void

type StreamRequest = {
  method: string
  params: unknown
  listener: StreamingListener
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
}

export type RpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
  subscribe: (
    method: string,
    params: unknown,
    onData: StreamingListener,
    options?: SubscribeOptions
  ) => () => void
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  getState: () => ConnectionState
  // 0 means never failed (reset on successful open); the UI escalates "Reconnecting…" to "Can't connect" past a threshold.
  getReconnectAttempt: () => number
  // Last 'connected' timestamp (ms epoch); null = never connected. Lets the UI tell "never reachable" from "transient blip".
  getLastConnectedAt: () => number | null
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  // Why: app-resume hook — iOS/Android can kill the TCP path while backgrounded; call on AppState 'active' to recover.
  notifyForeground: () => void
  close: () => void
}

// Why: tiered backoff — fast early entries recover blips; the slow tail avoids burning a SYN every 4s on an unreachable desktop.
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
// Why: ≈6 min of failure before the re-pair banner; MUST stay aligned with connection-health.ts UNREACHABLE_ATTEMPTS.
const GIVE_UP_AFTER_ATTEMPTS = 12
// Why: never park past the cap — a wedged VPN fires no AppState/network nudge to revive it, so trickle-dial every 90s to self-heal.
const TRICKLE_RECONNECT_DELAY_MS = 90_000
// Why: one unauthorized isn't proof the pairing is dead (issue #5200) — retry the handshake this many times before latching auth-failed.
const AUTH_RETRY_BUDGET = 3
const REQUEST_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 5_000
// Why: RN may not expose WebSocket.readyState constants, but the CONNECTING protocol value (0) is stable across runtimes.
const WEBSOCKET_CONNECTING_STATE = 0

// Why: RN auto-pongs pings natively, so JS needs an app-level probe to detect half-open sockets.
const ACTIVITY_PROBE_INTERVAL_MS = 20_000

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  // Fires for every lifecycle event so the UI can show where 'Connecting…' is stuck (e.g. broken Tailscale route).
  onLog?: ConnectionLogSink
}

export function connect(
  endpoint: string,
  deviceToken: string,
  serverPublicKeyB64: string,
  optionsOrLegacy?: ConnectOptions | ((state: ConnectionState) => void)
): RpcClient {
  // Why: keep backward-compat with callers that pass a bare onStateChange fn.
  const options: ConnectOptions =
    typeof optionsOrLegacy === 'function'
      ? { onStateChange: optionsOrLegacy }
      : (optionsOrLegacy ?? {})
  const onStateChange = options.onStateChange
  const onLog = options.onLog
  let logCounter = 0
  function emitLog(level: ConnectionLogLevel, message: string, detail?: string) {
    if (!onLog) {
      return
    }
    onLog({
      id: `log-${++logCounter}-${Date.now()}`,
      ts: Date.now(),
      level,
      message,
      detail
    })
  }
  let ws: WebSocket | null = null
  let state: ConnectionState = 'disconnected'
  let requestCounter = 0
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectTimer: ReturnType<typeof setTimeout> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let activityProbeTimer: ReturnType<typeof setInterval> | null = null
  let intentionallyClosed = false
  // Consecutive auth rejections; tolerate up to AUTH_RETRY_BUDGET (issue #5200) before latching to avoid a needless re-pair.
  let authRejectionCount = 0
  let lastConnectedAt: number | null = null
  // Why: cheap diagnostics for RN/OkHttp process-state poisoning (retry cadence, inbound traffic, close timing).
  let lastInboundAt: number | null = null
  let inboundSequence = 0
  let lastWsClosedAt: number | null = null
  let wsConstructionCounter = 0
  let currentWsOpenedAt: number | null = null

  // Why: fresh ephemeral keypair per connection provides forward secrecy.
  let sharedKey: Uint8Array | null = null
  const serverPublicKey = publicKeyFromBase64(serverPublicKeyB64)

  const pending = new Map<string, PendingRequest>()
  const streamListeners = new Map<string, StreamRequest>()
  const terminalStreamListeners = new Map<number, StreamingListener>()
  const terminalStreamIdsByRequest = new Map<string, Set<number>>()
  const terminalSnapshots = new Map<number, TerminalSnapshotState>()
  let activeBrowserScreencastRequestId: string | null = null
  let pendingBrowserScreencastRequestId: string | null = null
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const connectWaiters: ConnectWaiter[] = []

  if (onStateChange) {
    stateListeners.add(onStateChange)
  }

  // Diagnostic: dwell time in the current state, for spotting "stuck in connecting/reconnecting".
  let stateEnteredAt = Date.now()

  function rejectConnectWaiters(reason: string) {
    const error = new Error(reason)
    for (const waiter of connectWaiters.splice(0)) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout)
      }
      waiter.reject(error)
    }
  }

  function setState(next: ConnectionState) {
    if (state === next) {
      return
    }
    const prev = state
    const dwelt = Date.now() - stateEnteredAt
    state = next
    stateEnteredAt = Date.now()
    console.log('[net] state', {
      from: prev,
      to: next,
      dweltMs: dwelt,
      attempt: reconnectAttempt,
      endpoint: redactedEndpoint(endpoint)
    })
    if (next === 'connected') {
      lastConnectedAt = Date.now()
      // Why: a clean handshake proves the token is valid — reset the auth retry budget.
      authRejectionCount = 0
      for (const waiter of connectWaiters.splice(0)) {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout)
        }
        waiter.resolve()
      }
    } else if (next === 'disconnected' || next === 'auth-failed') {
      const reason =
        next === 'auth-failed' ? 'Unauthorized — pairing may be revoked' : 'Connection closed'
      rejectConnectWaiters(reason)
    }
    for (const listener of stateListeners) {
      listener(next)
    }
  }

  // Why: keep device tokens / full URLs out of log scrolls — truncate to host:port.
  function redactedEndpoint(ep: string): string {
    try {
      const m = ep.match(/^wss?:\/\/([^/]+)/i)
      return m ? m[1] : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  function waitForConnected(timeoutMs?: number): Promise<void> {
    if (state === 'connected') {
      return Promise.resolve()
    }
    if (intentionallyClosed) {
      return Promise.reject(new Error('Client closed'))
    }
    if (state === 'reconnecting' && reconnectAttempt >= GIVE_UP_AFTER_ATTEMPTS) {
      // Why: past the cap the loop only trickles every 90s — fail fast instead of hanging on a long-unreachable host.
      return Promise.reject(new Error('Connection retry limit reached'))
    }
    return new Promise((resolve, reject) => {
      const waiter: ConnectWaiter = { resolve, reject, timeout: null }
      if (timeoutMs !== undefined) {
        // Why: per-request timeouts must cover offline/reconnect waiting, not just the RPC after connect.
        waiter.timeout = setTimeout(
          () => {
            const index = connectWaiters.indexOf(waiter)
            if (index !== -1) {
              connectWaiters.splice(index, 1)
            }
            reject(new Error('Timed out while connecting to the remote Orca runtime.'))
          },
          Math.max(0, timeoutMs)
        )
      }
      connectWaiters.push(waiter)
    })
  }

  function nextId(): string {
    return `rpc-${++requestCounter}-${Date.now()}`
  }

  function openConnection() {
    if (intentionallyClosed) {
      return
    }

    const now = Date.now()
    wsConstructionCounter++
    console.log('[net] openConnection', {
      attempt: reconnectAttempt,
      endpoint: redactedEndpoint(endpoint),
      // Why: diagnostic for RN/OkHttp pool corruption — high wsCount + repeated 1006 closes means process-state stuck.
      wsCount: wsConstructionCounter,
      msSinceLastConnected: lastConnectedAt != null ? now - lastConnectedAt : null,
      msSinceLastClose: lastWsClosedAt != null ? now - lastWsClosedAt : null,
      msSinceLastInbound: lastInboundAt != null ? now - lastInboundAt : null
    })
    setState('connecting')
    sharedKey = null

    currentWsOpenedAt = now
    emitLog(
      'info',
      reconnectAttempt > 0 ? `Reconnecting (attempt ${reconnectAttempt + 1})` : 'Opening WebSocket',
      endpoint
    )

    ws = new WebSocket(endpoint)
    const openingWs = ws
    const ignoreStaleSocketEvent = (eventName: string): boolean => {
      if (ws === openingWs) {
        return false
      }
      // Why: RN can deliver callbacks from a timed-out socket after reconnect swapped in a replacement — ignore them.
      console.log('[net] stale ws event ignored', {
        eventName,
        state,
        attempt: reconnectAttempt
      })
      return true
    }

    // Why: RN can leave opens pending forever on flaky handoffs — force reconnect if onopen never arrives.
    connectTimer = setTimeout(() => {
      connectTimer = null
      if (ws === openingWs && openingWs.readyState === WEBSOCKET_CONNECTING_STATE) {
        console.log('[net] connect-timeout fired (onopen never arrived)', {
          attempt: reconnectAttempt,
          timeoutMs: CONNECT_TIMEOUT_MS
        })
        emitLog(
          'error',
          'WebSocket connect timeout',
          `No TCP/WS handshake within ${CONNECT_TIMEOUT_MS / 1000}s — endpoint unreachable?`
        )
        openingWs.close()
        if (ws === openingWs) {
          handleSocketClosed(openingWs, { timedOut: true })
        }
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (ignoreStaleSocketEvent('open')) {
        return
      }
      console.log('[net] ws.onopen', { attempt: reconnectAttempt })
      clearConnectTimer()
      reconnectAttempt = 0
      setState('handshaking')
      emitLog('success', 'WebSocket open', 'Starting E2EE handshake')

      // Why: fresh ephemeral keypair per connection provides forward secrecy.
      const ephemeral = generateKeyPair()
      const hello = JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(ephemeral.publicKey)
      })
      openingWs.send(hello)
      emitLog('info', 'Sent e2ee_hello', 'Awaiting server e2ee_ready')

      sharedKey = deriveSharedKey(ephemeral.secretKey, serverPublicKey)

      handshakeTimer = setTimeout(() => {
        handshakeTimer = null
        if (ws !== openingWs || state !== 'handshaking') {
          return
        }
        console.log('[net] handshake-timeout fired (e2ee_authenticated never arrived)', {
          timeoutMs: HANDSHAKE_TIMEOUT_MS
        })
        emitLog(
          'error',
          'Handshake timeout',
          `No e2ee_ready/e2ee_authenticated within ${HANDSHAKE_TIMEOUT_MS / 1000}s`
        )
        openingWs.close()
      }, HANDSHAKE_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      if (ignoreStaleSocketEvent('message')) {
        return
      }
      void handleSocketMessage(event.data)
    }

    async function handleSocketMessage(rawData: unknown) {
      lastInboundAt = Date.now()
      const raw = typeof rawData === 'string' ? rawData : null

      // Why: e2ee_ready is plaintext (precedes encrypted auth); e2ee_authenticated/e2ee_error are encrypted.
      if (state === 'handshaking') {
        if (raw === null) {
          return
        }
        try {
          const msg = JSON.parse(raw)
          if (msg.type === 'e2ee_ready') {
            emitLog('success', 'Received e2ee_ready', 'Sending device token')
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
            console.log('[net] e2ee_authenticated — connected', {
              streamCount: streamListeners.size
            })
            setState('connected')
            emitLog('success', 'Authenticated', 'Channel ready for RPC')
            startActivityProbe()
            for (const [id, stream] of streamListeners) {
              if (stream.cancelled) {
                removeStreamListener(id)
                continue
              }
              // Why: a UI listener notified synchronously by setState('connected') may already have sent this stream — skip it.
              if (stream.sent) {
                continue
              }
              if (stream.method === 'browser.screencast') {
                pendingBrowserScreencastRequestId = id
                activeBrowserScreencastRequestId = null
              }
              resetTerminalStreamRoutingForRequest(id)
              if (
                sendEncrypted({ id, deviceToken, method: stream.method, params: stream.params })
              ) {
                stream.sent = true
              } else {
                emitStreamError(stream, 'Connection interrupted')
                removeStreamListener(id)
              }
            }
          } else if (msg.type === 'e2ee_error' || (!msg.ok && msg.error?.code === 'unauthorized')) {
            console.log('[net] e2ee auth FAILED', { msgType: msg.type, error: msg.error })
            if (handshakeTimer) {
              clearTimeout(handshakeTimer)
              handshakeTimer = null
            }
            handleAuthRejection('Unauthorized — pairing may be revoked')
          }
        } catch {
          // Not JSON — ignore during handshake.
        }
        return
      }

      // Why: sharedKey can be null after destroy() or a reconnect race — don't decrypt with an invalid key.
      if (!sharedKey || sharedKey.length !== 32) {
        return
      }

      if (raw === null) {
        const bytes = await websocketPayloadToUint8(rawData)
        if (ws !== openingWs) {
          return
        }
        if (!bytes) {
          return
        }
        const plaintextBytes = decryptBytes(bytes, sharedKey)
        if (!plaintextBytes) {
          return
        }
        handleBinaryFrame(plaintextBytes)
        return
      }

      const plaintext = decrypt(raw, sharedKey)
      if (plaintext === null) {
        return
      }

      let response: unknown
      try {
        response = JSON.parse(plaintext)
      } catch {
        return
      }
      if (!isRpcResponse(response)) {
        return
      }
      recordValidatedInboundTraffic()

      // Why: a mid-session unauthorized may be transient (issue #5200) — handleAuthRejection retries before latching auth-failed.
      if (!response.ok && response.error.code === 'unauthorized') {
        handleAuthRejection('Unauthorized — pairing may be revoked')
        return
      }

      const isStreaming = response.ok && (response as RpcSuccess).streaming === true

      if (isStreaming) {
        const stream = streamListeners.get(response.id)
        if (stream && response.ok) {
          const result = (response as RpcSuccess).result
          if (isStreamingSubscriptionReadyResult(result)) {
            stream.subscriptionId = result.subscriptionId
            if (stream.cancelled) {
              sendServerSubscriptionUnsubscribe(stream)
              removeStreamListener(response.id)
              return
            }
            if (stream.method === 'browser.screencast') {
              if (
                pendingBrowserScreencastRequestId !== response.id &&
                activeBrowserScreencastRequestId !== response.id
              ) {
                sendBrowserScreencastUnsubscribe(result.subscriptionId)
                removeStreamListener(response.id)
                return
              }
              pendingBrowserScreencastRequestId = null
              activeBrowserScreencastRequestId = response.id
            }
          }
          if (isTerminalSubscribedResult(result)) {
            let ids = terminalStreamIdsByRequest.get(response.id)
            if (!ids) {
              ids = new Set()
              terminalStreamIdsByRequest.set(response.id, ids)
            }
            ids.add(result.streamId)
            terminalStreamListeners.set(result.streamId, stream.listener)
          }
          if (!stream.cancelled) {
            stream.listener(result)
          }
        }
        return
      }

      if (response.ok) {
        const result = (response as RpcSuccess).result as Record<string, unknown> | null
        if (result && result.type === 'end') {
          const stream = streamListeners.get(response.id)
          if (stream) {
            if (!stream.cancelled) {
              stream.listener(result)
            }
            removeStreamListener(response.id)
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

      const stream = streamListeners.get(response.id)
      if (stream) {
        if (!response.ok) {
          emitStreamError(stream, response.error.message, response.error)
        } else {
          emitStreamError(stream, 'Streaming request ended before it was ready.')
        }
        removeStreamListener(response.id)
        return
      }

      const req = pending.get(response.id)
      if (req) {
        pending.delete(response.id)
        req.resolve(response)
      }
    }

    ws.onclose = (event) => {
      const e = event as { code?: number; reason?: string; wasClean?: boolean } | undefined
      const closeAt = Date.now()
      // Why: time-since-construct classifies the failure — instant close = RST/unreachable, slow = SYN timeout/packet loss.
      const constructToCloseMs = currentWsOpenedAt != null ? closeAt - currentWsOpenedAt : null
      const aliveMs =
        currentWsOpenedAt != null && state === 'connected' ? closeAt - currentWsOpenedAt : null
      const inboundIdleMs = lastInboundAt != null ? closeAt - lastInboundAt : null
      // Why: statically imported — a hot-reload bug came from a stale closure capturing a half-loaded module.
      const closeEvent = describeSocketEvent(event)
      console.log('[net] ws.onclose', {
        code: e?.code,
        reason: e?.reason,
        wasClean: e?.wasClean,
        state,
        attempt: reconnectAttempt,
        intentionallyClosed,
        endpoint: redactedEndpoint(endpoint),
        constructToCloseMs,
        aliveMs,
        inboundIdleMs,
        eventKeys: closeEvent.keys,
        eventStr: closeEvent.json
      })
      lastWsClosedAt = closeAt
      currentWsOpenedAt = null
      handleSocketClosed(openingWs)
    }

    ws.onerror = (event) => {
      if (ignoreStaleSocketEvent('error')) {
        return
      }
      // Why: RN surfaces the original network error here — onclose follows but its close code alone hides the cause.
      const e = event as { message?: string } | undefined
      const errEvent = describeSocketEvent(event)
      console.log('[net] ws.onerror', {
        message: e?.message,
        state,
        attempt: reconnectAttempt,
        eventKeys: errEvent.keys,
        eventStr: errEvent.json
      })
    }
  }

  function handleSocketClosed(closedWs: WebSocket, opts: { timedOut?: boolean } = {}) {
    if (ws !== closedWs) {
      console.log('[net] handleSocketClosed STALE — ignoring (ws already swapped)', {
        state,
        attempt: reconnectAttempt
      })
      return
    }
    clearConnectTimer()
    ws = null
    sharedKey = null
    activeBrowserScreencastRequestId = null
    pendingBrowserScreencastRequestId = null
    markStreamsForReplay()
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    stopActivityProbe()
    if (intentionallyClosed) {
      console.log('[net] handleSocketClosed — intentional close')
      setState('disconnected')
      rejectAllPending('Connection closed')
      return
    }
    console.log('[net] handleSocketClosed → reconnect', {
      timedOut: !!opts.timedOut,
      pendingCount: pending.size,
      streamCount: streamListeners.size,
      attempt: reconnectAttempt
    })
    emitLog('warn', 'WebSocket closed', 'Will attempt to reconnect')
    rejectAllPending('Connection interrupted')
    setState('reconnecting')
    scheduleReconnect()
  }

  // Why: an auth rejection may be transient (issue #5200) — retry up to AUTH_RETRY_BUDGET times before latching auth-failed.
  function handleAuthRejection(reason: string): void {
    activeBrowserScreencastRequestId = null
    pendingBrowserScreencastRequestId = null
    authRejectionCount++
    if (authRejectionCount < AUTH_RETRY_BUDGET) {
      console.log('[net] auth rejected — retrying handshake', {
        attempt: authRejectionCount,
        budget: AUTH_RETRY_BUDGET,
        endpoint: redactedEndpoint(endpoint)
      })
      emitLog(
        'warn',
        'Authentication rejected',
        `Retrying (${authRejectionCount}/${AUTH_RETRY_BUDGET})`
      )
      // Why: close without setting intentionallyClosed so handleSocketClosed routes to reconnect and retries the handshake.
      const closing = ws
      ws = null
      sharedKey = null
      // Why: close cleanup stale-bails here, so mark active streams for replay.
      markStreamsForReplay()
      rejectAllPending(reason)
      if (closing) {
        closing.close()
      }
      setState('reconnecting')
      scheduleReconnect()
      return
    }
    console.log('[net] auth rejected — budget exhausted, latching auth-failed', {
      attempt: authRejectionCount,
      endpoint: redactedEndpoint(endpoint)
    })
    intentionallyClosed = true
    ws?.close()
    ws = null
    setState('auth-failed')
    rejectAllPending(reason)
  }

  function scheduleReconnect() {
    // Why: past the cap, trickle (never park) — a parked loop only revives on a network transition a wedged VPN never produces.
    const pastGiveUpCap = reconnectAttempt >= GIVE_UP_AFTER_ATTEMPTS
    let delay: number
    if (pastGiveUpCap) {
      // Why: hold the counter at the cap — connection-health's "Can't reach desktop" verdict keys off attempts >= 12.
      delay = TRICKLE_RECONNECT_DELAY_MS
      rejectConnectWaiters('Connection retry limit reached')
    } else {
      delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!
      reconnectAttempt++
    }
    console.log('[net] scheduleReconnect', {
      delayMs: delay,
      attempt: reconnectAttempt,
      trickle: pastGiveUpCap
    })
    emitLog(
      'info',
      `Reconnect scheduled in ${delay}ms`,
      pastGiveUpCap ? `Attempt ${reconnectAttempt} (slow retry)` : `Attempt ${reconnectAttempt}`
    )
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openConnection()
    }, delay)
  }

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
  }

  // Why: app-level liveness probe (see ACTIVITY_PROBE_INTERVAL_MS) — force-closes the WS on failure so onclose reconnects.
  function runActivityProbe() {
    if (state !== 'connected' || !ws) {
      return
    }
    const probeWs = ws
    const id = nextId()
    const probeInboundSequence = inboundSequence
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      pending.delete(id)
      if (inboundSequence > probeInboundSequence) {
        return
      }
      console.log('[net] activity-probe TIMEOUT — forcing reconnect', { state })
      // Why: stale probe timers must not close a replacement socket.
      if (probeWs === ws && probeWs.readyState === WebSocket.OPEN) {
        probeWs.close()
      }
    }, 8_000)
    pending.set(id, {
      resolve: () => {
        if (timedOut) {
          return
        }
        clearTimeout(timeout)
      },
      reject: () => {
        if (timedOut) {
          return
        }
        clearTimeout(timeout)
      }
    })
    if (!sendEncrypted({ id, deviceToken, method: 'status.get' })) {
      clearTimeout(timeout)
      pending.delete(id)
    }
  }

  function startActivityProbe() {
    stopActivityProbe()
    activityProbeTimer = setInterval(runActivityProbe, ACTIVITY_PROBE_INTERVAL_MS)
  }

  function stopActivityProbe() {
    if (activityProbeTimer) {
      clearInterval(activityProbeTimer)
      activityProbeTimer = null
    }
  }

  function rejectAllPending(reason: string) {
    const error = new Error(reason)
    for (const [id, req] of pending) {
      pending.delete(id)
      queueMicrotask(() => req.reject(error))
    }
  }

  function removeStreamListener(id: string): void {
    const stream = streamListeners.get(id)
    streamListeners.delete(id)
    if (activeBrowserScreencastRequestId === id) {
      activeBrowserScreencastRequestId = null
    }
    if (pendingBrowserScreencastRequestId === id) {
      pendingBrowserScreencastRequestId = null
    }
    const terminalStreamIds = terminalStreamIdsByRequest.get(id)
    if (terminalStreamIds) {
      for (const streamId of terminalStreamIds) {
        terminalStreamListeners.delete(streamId)
        terminalSnapshots.delete(streamId)
      }
      terminalStreamIdsByRequest.delete(id)
    }
    if (stream?.method === 'browser.screencast') {
      stream.cancelled = true
    }
  }

  function markStreamsForReplay(): void {
    for (const [id, stream] of streamListeners) {
      stream.sent = false
      resetTerminalStreamRoutingForRequest(id)
    }
  }

  function resetTerminalStreamRoutingForRequest(id: string): void {
    const terminalStreamIds = terminalStreamIdsByRequest.get(id)
    if (!terminalStreamIds) {
      return
    }
    for (const streamId of terminalStreamIds) {
      terminalStreamListeners.delete(streamId)
      terminalSnapshots.delete(streamId)
    }
    terminalStreamIdsByRequest.delete(id)
  }

  function emitStreamError(stream: StreamRequest, message: string, error?: unknown): void {
    if (stream.cancelled) {
      return
    }
    stream.listener({ type: 'error', message, error })
  }

  function disposeBrowserScreencastStream(id: string): void {
    const stream = streamListeners.get(id)
    if (!stream || stream.method !== 'browser.screencast') {
      return
    }
    stream.cancelled = true
    if (activeBrowserScreencastRequestId === id) {
      activeBrowserScreencastRequestId = null
    }
    if (pendingBrowserScreencastRequestId === id) {
      pendingBrowserScreencastRequestId = null
    }
    disposeServerSubscriptionStream(id, stream)
  }

  function disposeRuntimeClientEventsStream(id: string): void {
    const stream = streamListeners.get(id)
    if (!stream || stream.method !== 'runtime.clientEvents.subscribe') {
      return
    }
    disposeServerSubscriptionStream(id, stream)
  }

  function disposeServerSubscriptionStream(id: string, stream: StreamRequest): void {
    stream.cancelled = true
    if (stream.subscriptionId) {
      sendServerSubscriptionUnsubscribe(stream)
      removeStreamListener(id)
      return
    }
    // Why: a sent stream may still reply `ready`; keep the tombstone to unsubscribe it (queued streams never reached the desktop).
    if (!stream.sent) {
      removeStreamListener(id)
    }
  }

  function recordValidatedInboundTraffic(): void {
    inboundSequence++
  }

  function handleBinaryFrame(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencastFrame(bytes)
    if (browserFrame) {
      recordValidatedInboundTraffic()
      handleBrowserBinaryFrame(browserFrame)
      return
    }
    handleTerminalBinaryFrame(bytes, {
      terminalSnapshots,
      getListener: (streamId) => terminalStreamListeners.get(streamId),
      recordValidatedInboundTraffic
    })
  }

  function handleBrowserBinaryFrame(frame: BrowserScreencastFrame) {
    if (!activeBrowserScreencastRequestId) {
      return
    }
    const stream = streamListeners.get(activeBrowserScreencastRequestId)
    if (!stream || stream.cancelled || stream.method !== 'browser.screencast') {
      return
    }
    stream.onBinaryFrame?.(frame)
  }

  function sendEncrypted(request: unknown): boolean {
    if (ws && ws.readyState === WebSocket.OPEN && sharedKey) {
      ws.send(encrypt(JSON.stringify(request), sharedKey))
      return true
    }
    console.log('[net] sendEncrypted FAILED — channel not ready', {
      hasWs: !!ws,
      readyState: ws?.readyState,
      hasKey: !!sharedKey,
      state
    })
    // Why: RN can drop onclose, leaving state 'connected' over a dead socket; force reconnect or every send silently fails forever.
    if (state === 'connected' && ws && ws.readyState !== WebSocket.OPEN) {
      console.log('[net] sendEncrypted detected ws desync — forcing reconnect', {
        readyState: ws.readyState
      })
      handleSocketClosed(ws, { timedOut: false })
    }
    return false
  }

  function sendBrowserScreencastUnsubscribe(subscriptionId: string): void {
    sendEncrypted({
      id: nextId(),
      deviceToken,
      method: 'browser.screencast.unsubscribe',
      params: { subscriptionId }
    })
  }

  function sendServerSubscriptionUnsubscribe(stream: StreamRequest): void {
    if (!stream.subscriptionId) {
      return
    }
    if (stream.method === 'browser.screencast') {
      sendBrowserScreencastUnsubscribe(stream.subscriptionId)
      return
    }
    if (stream.method === 'runtime.clientEvents.subscribe') {
      sendEncrypted({
        id: nextId(),
        deviceToken,
        method: 'runtime.clientEvents.unsubscribe',
        params: { subscriptionId: stream.subscriptionId }
      })
    }
  }

  openConnection()

  return {
    async sendRequest(
      method: string,
      params?: unknown,
      options?: SendRequestOptions
    ): Promise<RpcResponse> {
      const waitStart = Date.now()
      const wasConnected = state === 'connected'
      await waitForConnected(options?.timeoutMs)
      if (!wasConnected) {
        console.log('[net] sendRequest waited for connect', {
          method,
          waitedMs: Date.now() - waitStart
        })
      }

      return new Promise((resolve, reject) => {
        const id = nextId()
        const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
        const timeout = setTimeout(() => {
          pending.delete(id)
          console.log('[net] sendRequest TIMEOUT', {
            method,
            timeoutMs,
            state
          })
          reject(new Error(`Request timed out: ${method}`))
        }, timeoutMs)

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

    subscribe(
      method: string,
      params: unknown,
      onData: StreamingListener,
      options?: SubscribeOptions
    ): () => void {
      const id = nextId()
      const stream: StreamRequest = {
        method,
        params,
        listener: onData,
        onBinaryFrame: options?.onBinaryFrame
      }
      streamListeners.set(id, stream)
      if (method === 'browser.screencast') {
        if (activeBrowserScreencastRequestId && activeBrowserScreencastRequestId !== id) {
          disposeBrowserScreencastStream(activeBrowserScreencastRequestId)
        }
        if (pendingBrowserScreencastRequestId && pendingBrowserScreencastRequestId !== id) {
          disposeBrowserScreencastStream(pendingBrowserScreencastRequestId)
        }
        // Why: screencast frames carry no stream id, so route only after the new stream's ready to drop stale old-page pixels.
        pendingBrowserScreencastRequestId = id
        activeBrowserScreencastRequestId = null
      }

      if (state === 'connected') {
        if (sendEncrypted({ id, deviceToken, method, params })) {
          stream.sent = true
        } else {
          emitStreamError(stream, 'Connection interrupted')
          removeStreamListener(id)
        }
      } else {
        // Registered now; the outbound subscribe is (re-)sent once the channel reaches 'connected'.
        console.log('[net] subscribe queued — waiting for connected', { method, state })
      }

      return () => {
        const stream = streamListeners.get(id)
        if (stream?.method === 'browser.screencast') {
          disposeBrowserScreencastStream(id)
          return
        }
        if (stream?.method === 'runtime.clientEvents.subscribe') {
          disposeRuntimeClientEventsStream(id)
          return
        }
        if (stream?.method === 'terminal.subscribe') {
          // Why: server keys cleanup by composite `${terminal}:${clientId}` so two phones don't evict each other. See docs/mobile-presence-lock.md.
          const unsubscribeParams = buildTerminalUnsubscribeParams(stream.params)
          if (unsubscribeParams) {
            sendEncrypted({
              id: nextId(),
              deviceToken,
              method: 'terminal.unsubscribe',
              params: unsubscribeParams
            })
          }
        } else {
          const unsub = buildStreamUnsubscribe(stream?.method, stream?.params)
          if (unsub) {
            sendEncrypted({ id: nextId(), deviceToken, method: unsub.method, params: unsub.params })
          }
        }
        removeStreamListener(id)
      }
    },

    updateTerminalSubscriptionViewport(
      terminal: string,
      viewport: { cols: number; rows: number }
    ): void {
      updateCachedTerminalSubscriptionViewport(streamListeners.values(), terminal, viewport)
    },

    getState(): ConnectionState {
      return state
    },

    getReconnectAttempt(): number {
      return reconnectAttempt
    },

    getLastConnectedAt(): number | null {
      return lastConnectedAt
    },

    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },

    notifyForeground(): void {
      if (intentionallyClosed) {
        return
      }
      if (state === 'connected') {
        // Why: OS can kill the TCP path while backgrounded without onclose; probe now to detect the half-open socket in ≤8s (issue #5049).
        console.log('[net] foreground — probing live connection')
        startActivityProbe()
        runActivityProbe()
        return
      }
      if (state === 'reconnecting') {
        // Why: foreground is a strong user signal — restart immediately instead of waiting out a 60s/90s backoff timer.
        console.log('[net] foreground — restarting reconnect loop', {
          attempt: reconnectAttempt,
          hadTimer: !!reconnectTimer
        })
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        reconnectAttempt = 0
        openConnection()
      }
    },

    close() {
      intentionallyClosed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      clearConnectTimer()
      if (handshakeTimer) {
        clearTimeout(handshakeTimer)
        handshakeTimer = null
      }
      stopActivityProbe()
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

function isTerminalSubscribedResult(
  value: unknown
): value is { type: 'subscribed'; streamId: number } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'subscribed' &&
    typeof (value as { streamId?: unknown }).streamId === 'number'
  )
}

function isStreamingSubscriptionReadyResult(
  value: unknown
): value is { type: 'ready'; subscriptionId: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'ready' &&
    typeof (value as { subscriptionId?: unknown }).subscriptionId === 'string'
  )
}
