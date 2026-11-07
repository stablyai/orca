// Duck-typed WebSocket for rpc-client over @orca/expo-iroh.
// Native module already applies 4B BE length framing; this layer only moves opaque E2EE bytes.
import { loadExpoIroh, type ExpoIrohApi } from './expo-iroh-native-module'
import { loadIrohHomeRelayUrl } from '../storage/preferences'
import { IROH_HOME_RELAY_URL_KEY, subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { PairingIrohSchema } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

const activeSockets = new Set<MobileIrohFramedSocket>()
let unsubscribeRelayPreference: (() => void) | null = null
let endpointStartBarrier: Promise<void> = Promise.resolve()
let requestedHomeRelayUrl: string | null | undefined
let relayRevision = 0
let startingRevision: number | null = null

/** Interrupts a pending native bind and waits for its stop before allowing another endpoint start. */
function interruptEndpointStart(): void {
  let stopped: Promise<void>
  try {
    // Interrupt before joining the queue: an old native bind may still be pending.
    stopped = loadExpoIroh()
      .irohStop()
      .catch(() => {})
  } catch {
    stopped = Promise.resolve()
  }
  endpointStartBarrier = Promise.all([endpointStartBarrier, stopped]).then(() => {})
}

/** Watches relay changes while sockets exist, closing them through RPC's normal reconnect path. */
function trackSocket(socket: MobileIrohFramedSocket): void {
  activeSockets.add(socket)
  unsubscribeRelayPreference ??= subscribeMirroredKey(IROH_HOME_RELAY_URL_KEY, (value) => {
    if (value === requestedHomeRelayUrl) {
      return
    }
    relayRevision += 1
    const superseded = [...activeSockets]
    interruptEndpointStart()
    for (const socket of superseded) {
      // Use the ordinary RPC close/reconnect path, including subscription replay.
      socket.close(1000, 'iroh_home_relay_changed')
    }
  })
}

/** Removes the shared preference listener and interrupts a pending bind when the last socket closes. */
function untrackSocket(socket: MobileIrohFramedSocket): void {
  activeSockets.delete(socket)
  if (activeSockets.size === 0) {
    unsubscribeRelayPreference?.()
    unsubscribeRelayPreference = null
    if (startingRevision === relayRevision) {
      interruptEndpointStart()
    }
  }
}

export type PathType = 'direct' | 'relayed' | 'mixed' | 'unknown'

type MessageEventLike = { data: string | Uint8Array }
type CloseEventLike = { code: number; reason: string }

export type MobileIrohFramedSocketOptions = {
  desktopEndpointId: string
  // Why: pairing-supplied hints — offline-LAN connect + skip discovery RTT.
  dialHints?: { relayUrl?: string; directAddresses?: string[] }
  onLog?: (message: string, detail?: string) => void
}

/**
 * Async-connecting socket: readyState starts CONNECTING, then OPEN or CLOSED.
 * Matches RN WebSocket enough for rpc-client (send/close + on* handlers).
 */
export class MobileIrohFramedSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.CONNECTING
  bufferedAmount = 0

  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: MessageEventLike) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  onclose: ((ev: CloseEventLike) => void) | null = null

  private connectionId: string | null = null
  private closed = false
  private unsubMessage: { remove: () => void } | null = null
  private unsubClosed: { remove: () => void } | null = null
  private unsubPath: { remove: () => void } | null = null
  private pathType: PathType = 'unknown'
  private sendQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: MobileIrohFramedSocketOptions) {
    trackSocket(this)
    void this.dial()
  }

  /**
   * Queues complete frames in call order; sends outside OPEN are ignored.
   * Native send failure clears buffered bytes and closes the socket with code 1011.
   */
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== this.OPEN || !this.connectionId || this.closed) {
      return
    }
    const bytes = toUint8Array(data)
    const byteLength = bytes.byteLength
    this.bufferedAmount += byteLength
    const connectionId = this.connectionId
    const b64 = uint8ToBase64(bytes)
    // Expo tasks can reach the native FIFO out of order; enqueue whole frames in JS.
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (this.closed) {
          return
        }
        try {
          await loadExpoIroh().irohSend(connectionId, b64)
          this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength)
        } catch (error) {
          this.bufferedAmount = 0
          try {
            this.options.onLog?.(
              'Iroh send failed',
              error instanceof Error ? error.message : String(error)
            )
          } finally {
            this.fail(1011, 'iroh_send_failed')
          }
        }
      })
      .catch((error) => {
        console.error('[iroh]', 'send callback failed', error)
      })
  }

  close(code?: number, reason?: string): void {
    // Why: a caller-initiated close is never an error, whatever code it carries.
    this.shutdown(code ?? 1000, reason ?? 'client_close', { signalError: false })
  }

  /**
   * Serializes endpoint startup using the latest relay preference, then dials the paired host.
   * Closed or superseded starts never open; native closes received during connect retain their reason.
   */
  private async dial(): Promise<void> {
    try {
      const iroh = loadExpoIroh()
      const start = endpointStartBarrier.then(async () => {
        if (this.closed) {
          return null
        }
        const dialTarget = PairingIrohSchema.safeParse({
          ...this.options.dialHints,
          endpointId: this.options.desktopEndpointId
        })
        if (!dialTarget.success) {
          const issue = dialTarget.error.issues[0]!
          throw new Error(`Invalid Iroh dial target: ${issue.path.join('.')}: ${issue.message}`)
        }
        const revision = relayRevision
        // The socket factory is reused on reconnect; never capture this in the logical client.
        const homeRelayUrl = await loadIrohHomeRelayUrl()
        if (this.closed || revision !== relayRevision) {
          return null
        }
        requestedHomeRelayUrl = homeRelayUrl
        startingRevision = revision
        try {
          const result = await iroh.irohStart(homeRelayUrl)
          return this.closed || revision !== relayRevision
            ? null
            : { endpointId: result.endpointId, dialTarget: dialTarget.data }
        } finally {
          startingRevision = null
        }
      })
      endpointStartBarrier = start.then(
        () => {},
        () => {}
      )
      const started = await start
      if (!started) {
        return
      }
      const { endpointId, dialTarget } = started
      const localEndpointPrefix = endpointId.slice(0, 12)
      const relayHintHost = dialTarget.relayUrl ? new URL(dialTarget.relayUrl).hostname : null
      console.log('[iroh]', 'endpoint_started', { localEndpointPrefix, relayHintHost })
      this.options.onLog?.(
        'Iroh endpoint started',
        `local=${localEndpointPrefix}; relay hint=${relayHintHost ?? 'discovery'}`
      )
      if (this.closed) {
        return
      }
      const endpointPrefix = dialTarget.endpointId.slice(0, 12)
      console.log('[iroh]', 'irohConnect_begin', {
        endpointPrefix,
        relayHintHost,
        directHintCount: dialTarget.directAddresses?.length ?? 0
      })
      // Native receive/close tasks start before the bridge resolves connect.
      // Keep early close reasons so an immediate 4001 cannot become a dead OPEN socket.
      const closedWhileConnecting = new Map<string, string>()
      this.unsubClosed = iroh.onIrohClosed((event) => {
        if (this.closed) {
          return
        }
        if (this.connectionId === null) {
          closedWhileConnecting.set(event.connectionId, event.reason)
        } else if (event.connectionId === this.connectionId) {
          this.handleNativeClose(event.reason)
        }
      })
      const { connectionId } = await iroh.irohConnect(dialTarget.endpointId, {
        relayUrl: dialTarget.relayUrl ?? null,
        directAddresses: dialTarget.directAddresses ?? []
      })
      console.log('[iroh]', 'irohConnect_ok', { connectionId: connectionId.slice(0, 8) })
      this.options.onLog?.('Iroh dial ok', connectionId.slice(0, 8))
      if (this.closed) {
        await iroh.irohClose(connectionId).catch(() => {})
        return
      }
      this.connectionId = connectionId
      const earlyCloseReason = closedWhileConnecting.get(connectionId)
      closedWhileConnecting.clear()
      if (earlyCloseReason !== undefined) {
        this.handleNativeClose(earlyCloseReason)
        return
      }
      this.bindNativeEvents(iroh, connectionId)
      this.readyState = this.OPEN
      this.onopen?.()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.log('[iroh]', 'irohStart_or_connect_err', { error: detail })
      this.options.onLog?.('Iroh start/connect failed', detail)
      this.fail(1006, detail || 'iroh_connect_failed')
    }
  }

  /** Delivers only this connection's messages and path updates while the socket remains live. */
  private bindNativeEvents(iroh: ExpoIrohApi, connectionId: string): void {
    this.unsubMessage = iroh.onIrohMessage((event) => {
      if (event.connectionId !== connectionId || this.closed) {
        return
      }
      const payload = base64ToUint8(event.bytesBase64)
      this.onmessage?.({ data: decodeIrohPayload(payload) })
    })
    this.unsubPath = iroh.onIrohPathChanged((event) => {
      if (event.connectionId !== connectionId || this.closed) {
        return
      }
      this.pathType = event.pathType
      console.log('[iroh]', 'path_changed', {
        pathType: event.pathType,
        detail: event.detail.slice(0, 120)
      })
      this.options.onLog?.(`Iroh path ${event.pathType}`, event.detail)
    })
  }

  /** Preserves the desktop's 4001 auth rejection so RPC requests re-pairing instead of reconnecting. */
  private handleNativeClose(reason: string): void {
    console.log('[iroh]', 'session_closed', { reason })
    // Why: the desktop closes QUIC with the WS auth code; surfacing 4001 lets
    // rpc-client latch auth-failed (re-pair banner) instead of reconnecting forever.
    // The pinned iroh-ffi versions expose quinn's ConnectionError Display,
    // e.g. "closed by peer: 4001: unauthorized"; revalidate on SDK upgrades.
    const code = /\b4001\b/.test(reason) ? 4001 : 1000
    this.fail(code, reason || 'iroh_closed')
  }

  private fail(code: number, reason: string): void {
    // Why: real WebSockets fire onerror only on failure — a peer that closed
    // cleanly (1000) is a drop to reconnect from, not an error to report.
    this.shutdown(code, reason, { signalError: code !== 1000 })
  }

  /**
   * Closes once, detaches native listeners, and releases the connection best-effort.
   * Delivers onclose even when an onerror handler throws.
   */
  private shutdown(code: number, reason: string, opts: { signalError: boolean }): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.readyState = this.CLOSED
    this.bufferedAmount = 0
    untrackSocket(this)
    this.unsubMessage?.remove()
    this.unsubPath?.remove()
    this.unsubClosed?.remove()
    this.unsubMessage = null
    this.unsubPath = null
    this.unsubClosed = null
    const connectionId = this.connectionId
    this.connectionId = null
    if (connectionId) {
      try {
        void loadExpoIroh()
          .irohClose(connectionId)
          .catch(() => {})
      } catch {
        // Module unavailable during teardown.
      }
    }
    try {
      if (opts.signalError) {
        this.onerror?.()
      }
    } finally {
      this.onclose?.({ code, reason })
    }
  }
}

/** UTF-8 encodes text and preserves binary view offsets without copying the underlying bytes. */
function toUint8Array(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/** Matches desktop ASCII text detection; non-text frames remain opaque bytes for E2EE decoding. */
function decodeIrohPayload(payload: Uint8Array): string | Uint8Array {
  for (let i = 0; i < payload.byteLength; i++) {
    const byte = payload[i]!
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return payload
    }
  }
  return new TextDecoder().decode(payload)
}

// Chunked fromCharCode avoids Hermes argument limits for sealed 8 MiB binary frames.
const BASE64_CHUNK = 0x8000

/** Base64-encodes bridge frames with bounded fromCharCode calls, including large Hermes frames. */
function uint8ToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK)))
  }
  return btoa(parts.join(''))
}

/** Restores native bridge bytes, propagating malformed base64 errors from atob. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
