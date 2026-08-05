import type { RpcResponse, RpcSuccess, ConnectionState, ConnectionLogLevel } from './types'
import {
  generateKeyPair,
  deriveSharedKey,
  publicKeyFromBase64,
  publicKeyToBase64,
  encrypt,
  decrypt,
  decryptBytes
} from './e2ee'
import type { TerminalSnapshotState } from './rpc-client-terminal-binary-frame'
import {
  routeRpcClientStreamFrame,
  type RpcClientStreamRequest as StreamRequest,
  type RpcStreamingListener as StreamingListener
} from './rpc-client-stream-frame-routing'
import type {
  ConnectOptions,
  RpcClient,
  SendRequestOptions,
  SubscribeOptions
} from './rpc-client-contract'
export type { ConnectOptions, RpcClient, SendRequestOptions } from './rpc-client-contract'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport as updateCachedTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import { describeSocketEvent, redactSocketEndpoint } from './socket-event-debug'
import {
  isStaleRpcSocketEvent,
  logRpcSocketClose,
  RpcSynthesizedCloseIndex
} from './rpc-socket-close-evidence'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { createRpcClientActivityProbe } from './rpc-client-activity-probe'
import { openRpcRequestBudget, resolvePostConnectRequestTimeout } from './rpc-request-budget'
import { isRpcResponse } from './rpc-response-shape'
import {
  consumeFirstStreamControlResponse,
  isStreamingSubscriptionReadyResult,
  isTerminalSubscribedResult
} from './rpc-stream-response-shape'
import { isStaleForegroundDial } from './rpc-stale-dial'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'
import { TimedOutControlRequestIndex } from './timed-out-control-request-index'
import { RpcApplicationResponseTracker } from './rpc-application-response-tracker'
import { RecoverableRpcError } from './recoverable-rpc-error'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  method?: string
}

type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

// Why: tiered backoff — fast early entries recover blips; the slow tail avoids burning a SYN every 4s on an unreachable desktop.
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
// Why: ≈6 min of failure before the re-pair banner; MUST stay aligned with connection-health.ts UNREACHABLE_ATTEMPTS.
const GIVE_UP_AFTER_ATTEMPTS = 12
// Why: never park past the cap — a wedged VPN fires no AppState/network nudge to revive it, so trickle-dial every 90s to self-heal.
const TRICKLE_RECONNECT_DELAY_MS = 90_000
// Why: one unauthorized isn't proof the pairing is dead (issue #5200) — retry the handshake this many times before latching auth-failed.
const AUTH_RETRY_BUDGET = 3
// Why: a desktop that regenerated its E2EE keypair sends an e2ee_error we can't decrypt — the 4001 close code is the only surviving auth-failure signal.
const UNAUTHORIZED_CLOSE_CODE = 4001
const REQUEST_TIMEOUT_MS = 30_000
// Why: an explicit `timeoutMs` is one budget for the whole call. If the connect wait
// ate nearly all of it, still give the written frame a moment to be answered rather
// than arming a 1ms timer.
const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 5_000
// Why: RN may not expose WebSocket.readyState constants, but the CONNECTING protocol value (0) is stable across runtimes.
const WEBSOCKET_CONNECTING_STATE = 0

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
  const { onStateChange, onLog } = options
  let logCounter = 0
  function emitLog(level: ConnectionLogLevel, message: string, detail?: string) {
    onLog?.({
      id: `log-${++logCounter}-${Date.now()}`,
      ts: Date.now(),
      level,
      message,
      detail
    })
  }
  let ws: WebSocket | null = null
  const synthesizedCloses = new RpcSynthesizedCloseIndex()
  let state: ConnectionState = 'disconnected'
  let requestCounter = 0
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectTimer: ReturnType<typeof setTimeout> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  const activityProbe = createRpcClientActivityProbe<WebSocket>({
    getConnectedSocket: () => (state === 'connected' ? ws : null),
    nextId: () => nextId(),
    getControlResponseSequence: () => controlResponseSequence,
    getInboundActivitySequence: () => inboundActivitySequence,
    rememberTimedOutControlId: (id) => timedOutControlRequestIds.remember(id),
    registerPendingProbe: (id, entry) => pending.set(id, entry),
    removePendingProbe: (id) => pending.delete(id),
    sendProbe: (id) => sendEncrypted({ id, deviceToken, method: 'status.get' }),
    demote: (socket) => {
      // Why: the recycle beats every application request to its own timeout, so
      // without this a wedged host re-authenticates forever behind a bare
      // 'Connected' with the reconnect counter reset each time (issue #10385).
      applicationResponseTracker.recordControlPlaneFailure('status.get')
      forceSocketReconnect(socket)
    }
  })
  let intentionallyClosed = false
  // Consecutive auth rejections; tolerate up to AUTH_RETRY_BUDGET (issue #5200) before latching to avoid a needless re-pair.
  let authRejectionCount = 0
  let authenticationGeneration = 0
  let lastConnectedAt: number | null = null
  // Why: cheap diagnostics for RN/OkHttp process-state poisoning (retry cadence, inbound traffic, close timing).
  let lastInboundAt: number | null = null
  let controlResponseSequence = 0
  // Why: decoded inbound frames prove the link still drains without proving
  // control health — they may only extend the probe deadline, never satisfy it.
  let inboundActivitySequence = 0
  let lastWsClosedAt: number | null = null
  let wsConstructionCounter = 0
  let dialStartedAt = 0

  // Why: fresh ephemeral keypair per connection provides forward secrecy.
  let sharedKey: Uint8Array | null = null
  const serverPublicKey = publicKeyFromBase64(serverPublicKeyB64)

  const pending = new Map<string, PendingRequest>()
  const timedOutControlRequestIds = new TimedOutControlRequestIndex()
  const applicationResponseTracker = new RpcApplicationResponseTracker(
    options.applicationResponsiveness,
    {
      onLatched: (method) => emitLog('warn', 'RPC channel not responding', `${method} timed out`),
      onRecovered: () => {
        reconnectAttempt = 0
        emitLog('success', 'RPC channel recovered', 'An application request completed')
      }
    }
  )
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
      endpoint: redactSocketEndpoint(endpoint)
    })
    if (next === 'connected') {
      lastConnectedAt = Date.now()
      authenticationGeneration++
      if (applicationResponseTracker.getUnresponsiveSince() == null) {
        reconnectAttempt = 0
      }
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
      endpoint: redactSocketEndpoint(endpoint),
      // Why: diagnostic for RN/OkHttp pool corruption — high wsCount + repeated 1006 closes means process-state stuck.
      wsCount: wsConstructionCounter,
      msSinceLastConnected: lastConnectedAt != null ? now - lastConnectedAt : null,
      msSinceLastClose: lastWsClosedAt != null ? now - lastWsClosedAt : null,
      msSinceLastInbound: lastInboundAt != null ? now - lastInboundAt : null
    })
    setState('connecting')
    dialStartedAt = now
    sharedKey = null

    emitLog(
      'info',
      reconnectAttempt > 0 ? `Reconnecting (attempt ${reconnectAttempt + 1})` : 'Opening WebSocket',
      redactSocketEndpoint(endpoint)
    )

    ws = new WebSocket(endpoint)
    const openingWs = ws
    let openingWsAuthenticated = false
    let openingWsLastInboundAt: number | null = null

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
        closeAndSynthesize(openingWs)
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (isStaleRpcSocketEvent(ws, openingWs, 'open', state, reconnectAttempt)) {
        return
      }
      console.log('[net] ws.onopen', { attempt: reconnectAttempt })
      clearConnectTimer()
      // Why: no reconnectAttempt reset here — an open socket isn't a healthy session
      // until e2ee_authenticated. Resetting pre-handshake pinned the counter at 0↔1,
      // so a handshake-stall loop never escalated past "Connecting…" (issue #10119).
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
        closeAndSynthesize(openingWs)
      }, HANDSHAKE_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      if (isStaleRpcSocketEvent(ws, openingWs, 'message', state, reconnectAttempt)) {
        return
      }
      void handleSocketMessage(event.data)
    }

    async function handleSocketMessage(rawData: unknown) {
      lastInboundAt = openingWsLastInboundAt = Date.now()
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
            clearHandshakeTimer()
            console.log('[net] e2ee_authenticated — connected', {
              streamCount: streamListeners.size
            })
            openingWsAuthenticated = true
            setState('connected')
            emitLog('success', 'Authenticated', 'Channel ready for RPC')
            activityProbe.start()
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
                sendEncrypted({
                  id,
                  deviceToken,
                  method: stream.method,
                  params: stream.params
                })
              ) {
                stream.sent = 'awaiting'
              } else {
                emitStreamError(stream, 'Connection interrupted')
                removeStreamListener(id)
              }
            }
          } else if (msg.type === 'e2ee_error' || (!msg.ok && msg.error?.code === 'unauthorized')) {
            console.log('[net] e2ee auth FAILED', { msgType: msg.type, error: msg.error })
            clearHandshakeTimer()
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
        const decoded = routeRpcClientStreamFrame(plaintextBytes, {
          activeBrowserRequestId: activeBrowserScreencastRequestId,
          streams: streamListeners,
          terminalSnapshots,
          terminalListeners: terminalStreamListeners
        })
        if (decoded) {
          inboundActivitySequence++
        }
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
      // Why: only well-formed frames prove the host pipeline drains — malformed
      // payloads must neither satisfy nor extend the probe.
      inboundActivitySequence++
      const request = pending.get(response.id)
      const lateApplicationResponse = applicationResponseTracker.consumeLateResponse(response.id)
      const responseStream = streamListeners.get(response.id)
      const firstStreamResponse = consumeFirstStreamControlResponse(responseStream)
      if (
        request ||
        timedOutControlRequestIds.consume(response.id) ||
        lateApplicationResponse ||
        firstStreamResponse
      ) {
        controlResponseSequence++
      }

      // Why: a mid-session unauthorized may be transient (issue #5200) — handleAuthRejection retries before latching auth-failed.
      if (!response.ok && response.error.code === 'unauthorized') {
        handleAuthRejection('Unauthorized — pairing may be revoked')
        return
      }
      const isStreaming = response.ok && (response as RpcSuccess).streaming === true

      if (isStreaming) {
        if (responseStream && response.ok) {
          const result = (response as RpcSuccess).result
          if (isStreamingSubscriptionReadyResult(result)) {
            responseStream.subscriptionId = result.subscriptionId
            if (responseStream.cancelled) {
              sendServerSubscriptionUnsubscribe(responseStream)
              removeStreamListener(response.id)
              return
            }
            if (responseStream.method === 'browser.screencast') {
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
            terminalStreamListeners.set(result.streamId, responseStream.listener)
          }
          if (!responseStream.cancelled) {
            responseStream.listener(result)
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
      const closeCode = logRpcSocketClose({
        event,
        state,
        attempt: reconnectAttempt,
        intentionallyClosed,
        endpoint: redactSocketEndpoint(endpoint),
        constructedAt: now,
        authenticated: openingWsAuthenticated,
        lastInboundAt: openingWsLastInboundAt
      })
      handleSocketClosed(openingWs, { closeCode })
    }

    ws.onerror = (event) => {
      if (isStaleRpcSocketEvent(ws, openingWs, 'error', state, reconnectAttempt)) {
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

  function handleSocketClosed(
    closedWs: WebSocket,
    opts: { timedOut?: boolean; closeCode?: number } = {}
  ) {
    if (ws !== closedWs) {
      if (
        synthesizedCloses.takeUnauthorized(
          closedWs,
          opts.closeCode,
          authenticationGeneration,
          UNAUTHORIZED_CLOSE_CODE
        )
      ) {
        handleAuthRejection('Unauthorized — pairing may be revoked', true)
        return
      }
      console.log('[net] handleSocketClosed STALE — ignoring (ws already swapped)', {
        state,
        attempt: reconnectAttempt
      })
      return
    }
    lastWsClosedAt = Date.now()
    clearConnectTimer()
    ws = null
    sharedKey = null
    activeBrowserScreencastRequestId = null
    pendingBrowserScreencastRequestId = null
    markStreamsForReplay()
    clearHandshakeTimer()
    activityProbe.stop()
    activityProbe.finishFollowUp()
    if (intentionallyClosed) {
      console.log('[net] handleSocketClosed — intentional close')
      setState('disconnected')
      rejectAllPending('Connection closed', { deliveryUnknown: true })
      return
    }
    // Why: a bare 4001 close means the desktop rejected our pairing but the encrypted
    // e2ee_error never arrived (or was undecryptable) — count it against the auth
    // retry budget instead of looping the generic reconnect forever.
    if (opts.closeCode === UNAUTHORIZED_CLOSE_CODE) {
      console.log('[net] handleSocketClosed — unauthorized close code', {
        attempt: reconnectAttempt
      })
      handleAuthRejection('Unauthorized — pairing may be revoked')
      return
    }
    console.log('[net] handleSocketClosed → reconnect', {
      timedOut: !!opts.timedOut,
      pendingCount: pending.size,
      streamCount: streamListeners.size,
      attempt: reconnectAttempt
    })
    emitLog('warn', 'WebSocket closed', 'Will attempt to reconnect')
    rejectAllPending('Connection interrupted', { deliveryUnknown: true })
    setState('reconnecting')
    scheduleReconnect()
  }

  // Why: an auth rejection may be transient (issue #5200) — retry up to AUTH_RETRY_BUDGET times before latching auth-failed.
  function handleAuthRejection(reason: string, preserveRecovery = false): void {
    authRejectionCount++
    if (authRejectionCount < AUTH_RETRY_BUDGET) {
      console.log('[net] auth rejected — retrying handshake', {
        attempt: authRejectionCount,
        budget: AUTH_RETRY_BUDGET,
        endpoint: redactSocketEndpoint(endpoint)
      })
      emitLog(
        'warn',
        'Authentication rejected',
        `Retrying (${authRejectionCount}/${AUTH_RETRY_BUDGET})`
      )
      if (preserveRecovery) {
        return
      }
      activeBrowserScreencastRequestId = null
      pendingBrowserScreencastRequestId = null
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
    activeBrowserScreencastRequestId = null
    pendingBrowserScreencastRequestId = null
    console.log('[net] auth rejected — budget exhausted, latching auth-failed', {
      attempt: authRejectionCount,
      endpoint: redactSocketEndpoint(endpoint)
    })
    intentionallyClosed = true
    ws?.close()
    ws = null
    // Why: auth-failed never reconnects on its own, so the probe interval would
    // otherwise tick for the life of the closure.
    activityProbe.stop()
    activityProbe.finishFollowUp()
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

  function clearHandshakeTimer() {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
  }

  // Why: a revival signal dials at once rather than waiting out the armed backoff.
  // Only the caller knows whether the attempt that led here should be forgiven.
  function redialNow(resetAttempts: boolean) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (resetAttempts) {
      reconnectAttempt = 0
    }
    openConnection()
  }

  // Why: React Native can omit onclose for a wedged iOS transport, so every forced
  // close has to synthesize the close event it may never deliver.
  function closeAndSynthesize(socket: WebSocket) {
    socket.close()
    if (ws === socket) {
      synthesizedCloses.remember(socket, authenticationGeneration)
      handleSocketClosed(socket, { timedOut: true })
    }
  }

  function forceSocketReconnect(socket: WebSocket | null): void {
    if (!socket || socket !== ws) {
      return
    }
    closeAndSynthesize(socket)
  }

  function rejectAllPending(reason: string, options?: { deliveryUnknown?: boolean }) {
    // Why: pending entries only exist after a successful socket write, so a close
    // here means the host may have processed them — mark the ambiguity for callers.
    const error = options?.deliveryUnknown
      ? markRpcDeliveryUnknown(new Error(reason))
      : new Error(reason)
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
      stream.sent = undefined
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
      synthesizedCloses.remember(ws, authenticationGeneration)
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
      const budget = openRpcRequestBudget(options)
      const waitStart = budget.startedAt
      const wasConnected = state === 'connected'
      if (options?.failWhenDisconnected && !wasConnected) {
        throw new Error(`Not connected: ${method}`)
      }
      await waitForConnected(options?.timeoutMs)
      if (!wasConnected) {
        console.log('[net] sendRequest waited for connect', {
          method,
          waitedMs: Date.now() - waitStart
        })
      }

      const requestWs = ws
      const timeoutMs = resolvePostConnectRequestTimeout(
        budget,
        REQUEST_TIMEOUT_MS,
        `Request timed out: ${method}`
      )
      return new Promise((resolve, reject) => {
        const id = nextId()
        const timeout = setTimeout(() => {
          pending.delete(id)
          console.log('[net] sendRequest TIMEOUT', {
            method,
            timeoutMs,
            state
          })
          // Why: the frame was written 30s ago — the host may have processed it.
          reject(markRpcDeliveryUnknown(new Error(`Request timed out: ${method}`)))
          if (requestWs === ws) {
            timedOutControlRequestIds.remember(id)
            if (
              applicationResponseTracker.recordTimeout(
                id,
                method,
                true,
                options?.applicationHealthProbe === true
              )
            ) {
              emitLog('error', 'RPC channel unresponsive', 'Recycling the connection')
              forceSocketReconnect(requestWs)
              return
            }
          }
          activityProbe.run(requestWs, true)
        }, timeoutMs)

        pending.set(id, {
          resolve: (response) => {
            clearTimeout(timeout)
            applicationResponseTracker.recordResponse(method)
            resolve(response)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          },
          method
        })

        if (!sendEncrypted({ id, deviceToken, method, params })) {
          pending.delete(id)
          clearTimeout(timeout)
          reject(new RecoverableRpcError('Connection interrupted'))
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
          stream.sent = 'awaiting'
        } else {
          emitStreamError(stream, 'Connection interrupted')
          removeStreamListener(id)
        }
      } else {
        // Registered now; the outbound subscribe is (re-)sent once the channel reaches 'connected'.
        console.log('[net] subscribe queued — waiting for connected', {
          method,
          state
        })
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
            sendEncrypted({
              id: nextId(),
              deviceToken,
              method: unsub.method,
              params: unsub.params
            })
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

    getRpcUnresponsiveSince(): number | null {
      return applicationResponseTracker.getUnresponsiveSince()
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
        activityProbe.start()
        activityProbe.run()
        return
      }
      const dialing = ws
      const dialAgeMs = Date.now() - dialStartedAt
      let abandoned = false
      if (dialing && isStaleForegroundDial(state, dialAgeMs)) {
        console.log('[net] foreground — abandoning stale dial', { state, dialAgeMs })
        closeAndSynthesize(dialing)
        abandoned = true
      }
      if (state === 'reconnecting') {
        // Why: foreground is a strong user signal — restart immediately instead of waiting out a 60s/90s backoff timer.
        console.log('[net] foreground — restarting reconnect loop', {
          attempt: reconnectAttempt,
          hadTimer: !!reconnectTimer
        })
        // Why: an abandoned dial keeps the failure it already represents. It never
        // authenticated, so it is the same failure the connect timeout would have
        // booked had we waited it out — we skip the wait, we don't pardon it. Zeroing
        // there would let a resume (or a flapping network) reset the counter faster
        // than it climbs, pinning the card at "Connecting…" through a real outage
        // (issue #10119). A redial with no dial to abandon is a genuinely fresh start.
        redialNow(!abandoned)
      }
    },

    close() {
      intentionallyClosed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      clearConnectTimer()
      clearHandshakeTimer()
      activityProbe.stop()
      activityProbe.finishFollowUp()
      if (ws) {
        ws.close()
        ws = null
      }
      sharedKey = null
      setState('disconnected')
      // Why: closing the client cannot retract request frames already written.
      rejectAllPending('Client closed', { deliveryUnknown: true })
    }
  }
}
