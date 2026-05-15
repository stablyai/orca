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
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from './terminal-stream-protocol'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type SendRequestOptions = {
  timeoutMs?: number
}

type StreamingListener = (result: unknown) => void

type StreamRequest = {
  method: string
  params: unknown
  listener: StreamingListener
}

type TerminalSnapshotState = {
  streamId: number
  meta: Record<string, unknown>
  chunks: string[]
}

export type RpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
  subscribe: (method: string, params: unknown, onData: StreamingListener) => () => void
  getState: () => ConnectionState
  // Why: UI escalates "Reconnecting…" to "Can't connect" once attempts cross
  // a threshold. 0 means never failed; counter is reset on successful open.
  getReconnectAttempt: () => number
  // Why: timestamp (ms epoch) of the last time we reached 'connected'.
  // null = never connected since the client was created. Used by the UI
  // to distinguish "host moved/never reachable" from "transient blip".
  getLastConnectedAt: () => number | null
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  close: () => void
}

// Why: tiered backoff. The first four entries (500ms→4s) keep
// auto-recovery snappy for the common case — a brief Wi-Fi blip,
// laptop wake, or AP-isolation cycle. Beyond that we slow down
// (8s→60s) so a phone whose desktop is genuinely unreachable doesn't
// burn a TCP SYN every 4s indefinitely while still healing on its
// own when the network recovers. With 12 total attempts, the last
// four reuse the 60s cap (Math.min(idx, length-1)), so total elapsed
// time across all 12 attempts is ≈ 6 minutes before the give-up cap
// fires (0.5+1+2+4+8+15+30+60+60+60+60+60 ≈ 360s).
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
// Why: cap auto-retry once we're clearly unreachable for a long time.
// With the tiered backoff above this is ≈ 6 minutes of continuous
// failure before we stop and surface the re-pair banner. The longer
// runway tolerates flaky AP-isolation routers and laptop sleep cycles
// that briefly drop the LAN path. MUST stay aligned with
// connection-health.ts UNREACHABLE_ATTEMPTS so the "unreachable"
// verdict matches the moment the loop actually pauses — if these
// drift the user sees "Reconnecting…" while the loop is silently
// parked.
const GIVE_UP_AFTER_ATTEMPTS = 12
const REQUEST_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 5_000
// Why: RN's WebSocket implementation may not expose static readyState
// constants, but the protocol value for CONNECTING is stable across runtimes.
const WEBSOCKET_CONNECTING_STATE = 0

// Why: app-level liveness probe. The server runs its own ping/pong sweep
// at 15s, but RN's WebSocket runtime auto-pongs at the native layer
// without surfacing anything to JS — so the mobile side can't *see* that
// the server thinks the link is fine. To detect a half-open socket from
// the mobile direction (e.g. server crashed, phone moved between wifi
// and cellular without TCP RST) we periodically round-trip a tiny RPC.
// If two consecutive probes time out we force-close the WS, which fires
// the existing reconnect path. 20s cadence + the 30s request timeout =
// worst-case ~50s before mobile decides the link is dead and kicks
// reconnect, which is still inside the user's perceived "responsive"
// window and well below iOS's typical background-disconnect window.
const ACTIVITY_PROBE_INTERVAL_MS = 20_000

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  // Fires for every observable lifecycle event so the UI can render a
  // detailed connection log. Useful when 'Connecting…' hangs forever
  // (e.g. broken Tailscale route) and you need to see *where* it's stuck.
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
    if (!onLog) return
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
  let lastConnectedAt: number | null = null
  // Why: diagnostic — when the rpc-client gets stuck in a state where every
  // openConnection fails with code 1006 and only a force-quit recovers, we
  // need to see whether (a) the new attempts even differ from the old ones,
  // (b) anything is happening at the OS / RN-bridge layer between attempts,
  // and (c) what the timing pattern is (instant 1006 = port closed / route
  // dead, slow 1006 = packet drop / timeout). These three timestamps + the
  // ws-construction counter are the cheapest visibility into RN/OkHttp
  // process-state poisoning hypotheses.
  let lastInboundAt: number | null = null
  let lastWsClosedAt: number | null = null
  let wsConstructionCounter = 0
  let currentWsOpenedAt: number | null = null

  // Why: fresh ephemeral keypair per connection provides forward secrecy.
  // The shared key is derived from our ephemeral secret + server's static public key.
  let sharedKey: Uint8Array | null = null
  const serverPublicKey = publicKeyFromBase64(serverPublicKeyB64)

  const pending = new Map<string, PendingRequest>()
  const streamListeners = new Map<string, StreamRequest>()
  const terminalStreamListeners = new Map<number, StreamingListener>()
  const terminalStreamIdsByRequest = new Map<string, Set<number>>()
  const terminalSnapshots = new Map<number, TerminalSnapshotState>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const connectWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []

  if (onStateChange) {
    stateListeners.add(onStateChange)
  }

  // Diagnostic: tracks how long we've been in the current state. Useful
  // for spotting "stuck in connecting" or "stuck in reconnecting" cases
  // in the logs.
  let stateEnteredAt = Date.now()

  function setState(next: ConnectionState) {
    if (state === next) return
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

  // Why: don't dump device tokens / full URLs into log scrolls; truncate to
  // the host:port so reconnect lifecycles are still readable.
  function redactedEndpoint(ep: string): string {
    try {
      const m = ep.match(/^wss?:\/\/([^/]+)/i)
      return m ? m[1] : 'unknown'
    } catch {
      return 'unknown'
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

    const now = Date.now()
    wsConstructionCounter++
    console.log('[net] openConnection', {
      attempt: reconnectAttempt,
      endpoint: redactedEndpoint(endpoint),
      // Why: process-poisoning diagnostic. If wsCount is high (e.g. >50)
      // and every recent open fails with 1006, suspect RN/OkHttp internal
      // pool corruption that only force-quit clears. Compare msSinceLast*
      // values to the failure cadence: instant repeated fails with no
      // inbound traffic between them = process-state stuck.
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

    // Why: React Native can leave TCP/WebSocket opens pending indefinitely on
    // flaky network handoffs. Force the existing onclose reconnect path if
    // onopen never arrives, instead of leaving the UI stuck at "Connecting...".
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
      console.log('[net] ws.onopen', { attempt: reconnectAttempt })
      clearConnectTimer()
      reconnectAttempt = 0
      setState('handshaking')
      emitLog('success', 'WebSocket open', 'Starting E2EE handshake')

      // Why: generate a fresh ephemeral keypair for each connection.
      // This provides forward secrecy — compromising one session's key
      // doesn't compromise past or future sessions.
      const ephemeral = generateKeyPair()
      const hello = JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(ephemeral.publicKey)
      })
      ws?.send(hello)
      emitLog('info', 'Sent e2ee_hello', 'Awaiting server e2ee_ready')

      sharedKey = deriveSharedKey(ephemeral.secretKey, serverPublicKey)

      handshakeTimer = setTimeout(() => {
        handshakeTimer = null
        console.log('[net] handshake-timeout fired (e2ee_authenticated never arrived)', {
          timeoutMs: HANDSHAKE_TIMEOUT_MS
        })
        emitLog(
          'error',
          'Handshake timeout',
          `No e2ee_ready/e2ee_authenticated within ${HANDSHAKE_TIMEOUT_MS / 1000}s`
        )
        ws?.close()
      }, HANDSHAKE_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      void handleSocketMessage(event.data)
    }

    async function handleSocketMessage(rawData: unknown) {
      // Why: track last-inbound for the openConnection diagnostic. Server
      // pongs and stream events both bump this — anything from the wire.
      lastInboundAt = Date.now()
      const raw = typeof rawData === 'string' ? rawData : null

      // Why: during handshaking, e2ee_ready is plaintext because it precedes
      // encrypted auth; e2ee_authenticated/e2ee_error are encrypted.
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
              sendEncrypted({ id, deviceToken, method: stream.method, params: stream.params })
            }
          } else if (msg.type === 'e2ee_error' || (!msg.ok && msg.error?.code === 'unauthorized')) {
            console.log('[net] e2ee auth FAILED', { msgType: msg.type, error: msg.error })
            emitLog(
              'error',
              'Authentication rejected',
              typeof msg.error?.message === 'string' ? msg.error.message : 'Unauthorized'
            )
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

      if (raw === null) {
        const bytes = await websocketPayloadToUint8(rawData)
        if (!bytes) {
          return
        }
        const plaintextBytes = decryptBytes(bytes, sharedKey)
        if (!plaintextBytes) {
          return
        }
        handleTerminalBinaryFrame(plaintextBytes)
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
          const result = (response as RpcSuccess).result
          if (isTerminalSubscribedResult(result)) {
            let ids = terminalStreamIdsByRequest.get(response.id)
            if (!ids) {
              ids = new Set()
              terminalStreamIdsByRequest.set(response.id, ids)
            }
            ids.add(result.streamId)
            terminalStreamListeners.set(result.streamId, stream.listener)
          }
          stream.listener(result)
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

    ws.onclose = (event) => {
      const e = event as { code?: number; reason?: string; wasClean?: boolean } | undefined
      const closeAt = Date.now()
      // Why: time-since-construct distinguishes failure modes. Instant
      // close (<300ms) = TCP RST / port closed / route unreachable / RN
      // synchronous reject. Mid (300ms–3s) = DNS/connect attempt + reset.
      // Slow (>3s) = TCP SYN timeout / packet loss / NAT wedge. If an
      // entire reconnect burst is all instant, the problem is local
      // process state or routing, not packet loss.
      const constructToCloseMs = currentWsOpenedAt != null ? closeAt - currentWsOpenedAt : null
      const aliveMs =
        currentWsOpenedAt != null && state === 'connected' ? closeAt - currentWsOpenedAt : null
      const inboundIdleMs = lastInboundAt != null ? closeAt - lastInboundAt : null
      // Why: inline the diagnostic dump. Earlier hot-reload tripped
      // `Property 'enumKeys' doesn't exist` because a stale closure
      // captured a half-loaded module. Inlining keeps the handler's
      // behavior fully decided at construction time.
      let closeEventKeys: string[] = []
      let closeEventStr = ''
      try {
        closeEventKeys = event && typeof event === 'object' ? Object.keys(event as object) : []
      } catch {
        closeEventKeys = []
      }
      try {
        const seen = new WeakSet<object>()
        closeEventStr = JSON.stringify(
          event,
          (_k, v) => {
            if (typeof v === 'object' && v !== null) {
              if (seen.has(v as object)) return '[circular]'
              seen.add(v as object)
            }
            if (typeof v === 'function') return '[fn]'
            return v
          },
          0
        ).slice(0, 500)
      } catch {
        closeEventStr = '[unstringifiable]'
      }
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
        eventKeys: closeEventKeys,
        eventStr: closeEventStr
      })
      lastWsClosedAt = closeAt
      currentWsOpenedAt = null
      handleSocketClosed(openingWs)
    }

    ws.onerror = (event) => {
      // Why: RN surfaces network errors here (DNS failure, TCP RST, etc).
      // onclose fires right after, but logging the error message gives us
      // the original cause that the close code alone can hide.
      const e = event as { message?: string } | undefined
      // Why: inlined defensively — see ws.onclose comment.
      let errEventKeys: string[] = []
      let errEventStr = ''
      try {
        errEventKeys = event && typeof event === 'object' ? Object.keys(event as object) : []
      } catch {
        errEventKeys = []
      }
      try {
        const seen = new WeakSet<object>()
        errEventStr = JSON.stringify(
          event,
          (_k, v) => {
            if (typeof v === 'object' && v !== null) {
              if (seen.has(v as object)) return '[circular]'
              seen.add(v as object)
            }
            if (typeof v === 'function') return '[fn]'
            return v
          },
          0
        ).slice(0, 500)
      } catch {
        errEventStr = '[unstringifiable]'
      }
      console.log('[net] ws.onerror', {
        message: e?.message,
        state,
        attempt: reconnectAttempt,
        eventKeys: errEventKeys,
        eventStr: errEventStr
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

  function scheduleReconnect() {
    // Why: spinning reconnect forever drains battery and floods logs
    // when the host is genuinely unreachable (wrong IP, port closed,
    // host moved). Cap at GIVE_UP_AFTER_ATTEMPTS — the UI surfaces a
    // "Can't reach desktop, re-pair?" banner at this point and the
    // user can tap Retry (forceReconnect creates a fresh client,
    // resetting the counter) or Re-pair. Without an explicit cap the
    // worst-case is a phone left on the home screen burning a socket
    // open every 4s indefinitely.
    if (reconnectAttempt >= GIVE_UP_AFTER_ATTEMPTS) {
      console.log('[net] reconnect-paused', {
        attempt: reconnectAttempt,
        reason: 'give-up-cap',
        endpoint: redactedEndpoint(endpoint)
      })
      return
    }
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!
    reconnectAttempt++
    console.log('[net] scheduleReconnect', { delayMs: delay, attempt: reconnectAttempt })
    emitLog('info', `Reconnect scheduled in ${delay}ms`, `Attempt ${reconnectAttempt}`)
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

  // Why: app-level liveness probe — see ACTIVITY_PROBE_INTERVAL_MS comment
  // at the top of the file. Fires while the channel is in 'connected'
  // state, sends a tiny status.get, and force-closes the WS if the probe
  // fails (which the existing onclose path then turns into a reconnect).
  function startActivityProbe() {
    stopActivityProbe()
    activityProbeTimer = setInterval(() => {
      // Why: only probe while the channel is actually in 'connected'. The
      // sendRequest path itself waits for connected, but a probe scheduled
      // during a reconnect would just stack up timeouts and confuse logs.
      if (state !== 'connected' || !ws) return
      const probeWs = ws
      // Why: short timeout (8s) — server's heartbeat is 15s, so if we
      // don't see *anything* back within 8s the link is almost certainly
      // half-open. Using REQUEST_TIMEOUT_MS (30s) here would make the
      // user wait nearly a minute before reconnect kicks in.
      const id = nextId()
      const probeStart = Date.now()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        pending.delete(id)
        console.log('[net] activity-probe TIMEOUT — forcing reconnect', {
          waitedMs: Date.now() - probeStart,
          state
        })
        // Why: only force-close if this is still the same socket the
        // probe was sent on; a normal close that already swapped `ws`
        // shouldn't trigger a redundant terminate.
        if (probeWs === ws && probeWs.readyState === WebSocket.OPEN) {
          probeWs.close()
        }
      }, 8_000)
      pending.set(id, {
        resolve: () => {
          if (timedOut) return
          clearTimeout(timeout)
        },
        reject: () => {
          if (timedOut) return
          clearTimeout(timeout)
        }
      })
      if (!sendEncrypted({ id, deviceToken, method: 'status.get' })) {
        clearTimeout(timeout)
        pending.delete(id)
      }
    }, ACTIVITY_PROBE_INTERVAL_MS)
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

  function handleTerminalBinaryFrame(bytes: Uint8Array) {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    const listener = terminalStreamListeners.get(frame.streamId)
    if (!listener) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Output) {
      listener({
        type: 'data',
        streamId: frame.streamId,
        chunk: decodeTerminalStreamText(frame.payload)
      })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
      const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
      if (!meta) {
        return
      }
      terminalSnapshots.set(frame.streamId, { streamId: frame.streamId, meta, chunks: [] })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
      const snapshot = terminalSnapshots.get(frame.streamId)
      if (!snapshot) {
        return
      }
      snapshot.chunks.push(decodeTerminalStreamText(frame.payload))
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
      const snapshot = terminalSnapshots.get(frame.streamId)
      if (!snapshot) {
        return
      }
      terminalSnapshots.delete(frame.streamId)
      const kind = snapshot.meta.kind === 'resized' ? 'resized' : 'scrollback'
      listener({
        ...snapshot.meta,
        type: kind,
        streamId: frame.streamId,
        serialized: snapshot.chunks.join('')
      })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Resized) {
      const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
      if (!meta) {
        return
      }
      listener({
        ...meta,
        type: 'resized',
        streamId: frame.streamId
      })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Error) {
      listener({
        type: 'error',
        streamId: frame.streamId,
        message: decodeTerminalStreamText(frame.payload)
      })
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
    // Why: if the state machine still thinks we're connected but the
    // underlying WebSocket has flipped to CLOSING/CLOSED without onclose
    // having fired (RN's WebSocket sometimes drops the event, or the
    // server half-closed the stream), force a reconnect. Without this
    // every send silently fails forever and the user sees a frozen UI.
    if (state === 'connected' && ws && ws.readyState !== WebSocket.OPEN) {
      console.log('[net] sendEncrypted detected ws desync — forcing reconnect', {
        readyState: ws.readyState
      })
      handleSocketClosed(ws, { timedOut: false })
    }
    return false
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
      await waitForConnected()
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

    subscribe(method: string, params: unknown, onData: StreamingListener): () => void {
      const id = nextId()
      streamListeners.set(id, { method, params, listener: onData })

      if (state === 'connected') {
        sendEncrypted({ id, deviceToken, method, params })
      } else {
        // Stream is registered but the actual outbound subscribe will be
        // sent (or re-sent) when the channel reaches 'connected'. Useful
        // when terminals don't load — confirms the request is queued.
        console.log('[net] subscribe queued — waiting for connected', { method, state })
      }

      return () => {
        const stream = streamListeners.get(id)
        streamListeners.delete(id)
        const terminalStreamIds = terminalStreamIdsByRequest.get(id)
        if (terminalStreamIds) {
          for (const streamId of terminalStreamIds) {
            terminalStreamListeners.delete(streamId)
            terminalSnapshots.delete(streamId)
          }
          terminalStreamIdsByRequest.delete(id)
        }
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
        } else if (
          stream?.method === 'session.tabs.subscribe' &&
          stream.params &&
          typeof stream.params === 'object' &&
          typeof (stream.params as { worktree?: unknown }).worktree === 'string'
        ) {
          sendEncrypted({
            id: nextId(),
            deviceToken,
            method: 'session.tabs.unsubscribe',
            params: { worktree: (stream.params as { worktree: string }).worktree }
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

    getLastConnectedAt(): number | null {
      return lastConnectedAt
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

async function websocketPayloadToUint8(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (value && typeof value === 'object' && 'arrayBuffer' in value) {
    const blob = value as { arrayBuffer: () => Promise<ArrayBuffer> }
    return new Uint8Array(await blob.arrayBuffer())
  }
  if (typeof FileReader !== 'undefined' && value instanceof Blob) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null)
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(value)
    })
  }
  return null
}
