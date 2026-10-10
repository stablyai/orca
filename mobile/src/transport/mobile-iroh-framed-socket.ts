// Duck-typed WebSocket for rpc-client over @orca/expo-iroh.
// Native module already applies 4B BE length framing; this layer only moves opaque E2EE bytes.
import { loadExpoIroh, type ExpoIrohApi } from './expo-iroh-native-module'

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

  constructor(private readonly options: MobileIrohFramedSocketOptions) {
    void this.dial()
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== this.OPEN || !this.connectionId || this.closed) {
      return
    }
    const bytes = toUint8Array(data)
    this.bufferedAmount += bytes.byteLength
    const connectionId = this.connectionId
    const b64 = uint8ToBase64(bytes)
    try {
      const iroh = loadExpoIroh()
      void iroh
        .irohSend(connectionId, b64)
        .then(() => {
          this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes.byteLength)
        })
        .catch((error: unknown) => {
          this.bufferedAmount = 0
          this.options.onLog?.(
            'Iroh send failed',
            error instanceof Error ? error.message : String(error)
          )
          this.fail(1011, 'iroh_send_failed')
        })
    } catch (error) {
      this.bufferedAmount = 0
      this.options.onLog?.(
        'Iroh send failed',
        error instanceof Error ? error.message : String(error)
      )
      this.fail(1011, 'iroh_send_failed')
    }
  }

  close(code?: number, reason?: string): void {
    // Why: a caller-initiated close is never an error, whatever code it carries.
    this.shutdown(code ?? 1000, reason ?? 'client_close', { signalError: false })
  }

  private async dial(): Promise<void> {
    try {
      const iroh = loadExpoIroh()
      await iroh.irohStart()
      console.log('[iroh]', 'endpoint_started')
      this.options.onLog?.('Iroh endpoint started')
      if (this.closed) {
        return
      }
      const endpointPrefix = this.options.desktopEndpointId.slice(0, 12)
      console.log('[iroh]', 'irohConnect_begin', { endpointPrefix })
      const { connectionId } = await iroh.irohConnect(this.options.desktopEndpointId, {
        relayUrl: this.options.dialHints?.relayUrl ?? null,
        directAddresses: this.options.dialHints?.directAddresses ?? []
      })
      console.log('[iroh]', 'irohConnect_ok', { connectionId: connectionId.slice(0, 8) })
      this.options.onLog?.('Iroh dial ok', connectionId.slice(0, 8))
      if (this.closed) {
        await iroh.irohClose(connectionId).catch(() => {})
        return
      }
      this.connectionId = connectionId
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
    this.unsubClosed = iroh.onIrohClosed((event) => {
      if (event.connectionId !== connectionId) {
        return
      }
      console.log('[iroh]', 'session_closed', { reason: event.reason })
      // Why: the desktop closes QUIC with the WS auth code; surfacing 4001 lets
      // rpc-client latch auth-failed (re-pair banner) instead of reconnecting forever.
      // event.reason is quinn's ConnectionError Display via iroh-ffi Connection.closed(),
      // e.g. "closed by peer: 4001: unauthorized" — the numeric application close code
      // always appears in that string (IrohLib 1.1); revalidate on iroh-ffi upgrades.
      const code = /\b4001\b/.test(event.reason) ? 4001 : 1000
      this.fail(code, event.reason || 'iroh_closed')
    })
  }

  private fail(code: number, reason: string): void {
    // Why: real WebSockets fire onerror only on failure — a peer that closed
    // cleanly (1000) is a drop to reconnect from, not an error to report.
    this.shutdown(code, reason, { signalError: code !== 1000 })
  }

  private shutdown(code: number, reason: string, opts: { signalError: boolean }): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.readyState = this.CLOSED
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
    if (opts.signalError) {
      this.onerror?.()
    }
    this.onclose?.({ code, reason })
  }
}

function toUint8Array(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

// Why: desktop decodeIrohFramePayload treats pure ASCII as text (JSON/base64 E2EE).
function decodeIrohPayload(payload: Uint8Array): string | Uint8Array {
  for (let i = 0; i < payload.byteLength; i++) {
    const byte = payload[i]!
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return payload
    }
  }
  return new TextDecoder().decode(payload)
}

// Why: chunked fromCharCode — frames approach 1 MiB and per-byte string
// concat is O(n) allocations on Hermes.
const BASE64_CHUNK = 0x8000

function uint8ToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK)))
  }
  return btoa(parts.join(''))
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
