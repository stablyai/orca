import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import type { PeerClientConnectionState, PeerClientStatus } from '../../shared/peer-client-status'
import type { PeerTerminalStreamEvent } from '../../shared/peer-terminal-stream-event'
import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'
import {
  PeerClientHandshake,
  UNAUTHORIZED_CLOSE_CODE,
  type HandshakeState
} from './peer-client-handshake'
import {
  PEER_DUPLICATE_CONNECTION_CLOSE_CODE,
  PEER_HOSTING_DISABLED_CLOSE_CODE
} from '../../shared/peer-connection-close-codes'
import { PeerClientRpcChannel } from './peer-client-rpc-channel'
import { PeerClientTerminalStreams } from './peer-client-terminal-streams'
import { PeerClientPresenceStreams } from './peer-client-presence-streams'

export type { PeerClientConnectionState, PeerClientStatus }

export type PeerClientConnectResult = { ok: true } | { ok: false; reason: string }

// Why: mirrors mobile/src/transport/rpc-client.ts's tiered backoff (kept in
// lockstep intentionally) minus the relay-candidate concerns that file also
// carries — a peer connection only ever has one local-only endpoint.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
const GIVE_UP_AFTER_ATTEMPTS = 12
const TRICKLE_RECONNECT_DELAY_MS = 90_000

export type PeerClientServiceOptions = {
  createSocket?: (endpoint: string) => WebSocket
}

// Why: desktop-side counterpart of mobile/src/transport/rpc-client.ts's
// connect(), ported to Node (ws + shared/e2ee-crypto, both already
// Node-compatible) so a client Orca can dial into another Orca's existing
// runtime-rpc WebSocket server using the same v1 e2ee_hello/e2ee_auth
// handshake it already accepts (requireV2 is only set for relay sockets).
export class PeerClientService {
  private readonly handshake: PeerClientHandshake
  private state: PeerClientConnectionState = 'closed'
  private offer: PairingOffer | null = null
  private displayName: string | null = null
  private intentionallyClosed = true
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastErrorReason: string | null = null
  private requestCounter = 0
  private readonly statusListeners = new Set<(status: PeerClientStatus) => void>()
  // Why: identifies this desktop to the host's driver arbitration, same role as a mobile client id.
  private clientId: string | null = null

  private readonly rpc: PeerClientRpcChannel
  private readonly terminalStreams: PeerClientTerminalStreams
  private readonly presenceStreams: PeerClientPresenceStreams

  constructor(options: PeerClientServiceOptions = {}) {
    const createSocket = options.createSocket ?? ((endpoint) => new WebSocket(endpoint))

    const getWs = (): WebSocket | null => this.handshake.getWs()
    const getSharedKey = (): Uint8Array | null => this.handshake.getSharedKey()
    const getOffer = (): PairingOffer | null => this.offer
    const getHandshakeState = (): HandshakeState => this.handshake.getState()
    const getClientId = (): string | null => this.clientId
    const nextCounter = (): number => ++this.requestCounter

    this.handshake = new PeerClientHandshake({
      createSocket,
      getDisplayName: () => this.displayName,
      onAuthenticated: () => {
        this.reconnectAttempt = 0
        this.lastErrorReason = null
        this.setState('connected')
      },
      onMessage: (message) => this.handleReadyMessage(message),
      onBinaryMessage: (raw) => this.terminalStreams.handleBinaryMessage(raw),
      onClosed: (code, transportError) => this.handleSocketClosed(code, transportError)
    })

    this.rpc = new PeerClientRpcChannel({
      getWs,
      getSharedKey,
      getOffer,
      getHandshakeState,
      nextCounter
    })
    this.terminalStreams = new PeerClientTerminalStreams({
      rpc: this.rpc,
      getOffer,
      getHandshakeState,
      getClientId,
      getWs,
      getSharedKey,
      nextCounter
    })
    this.presenceStreams = new PeerClientPresenceStreams({
      rpc: this.rpc,
      getOffer,
      getHandshakeState,
      getClientId,
      nextCounter
    })
  }

  getStatus(): PeerClientStatus {
    return {
      state: this.state,
      endpoint: this.offer?.endpoint ?? null,
      reconnectAttempt: this.reconnectAttempt,
      lastErrorReason: this.lastErrorReason
    }
  }

  onStatusChange(listener: (status: PeerClientStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  // Why: the renderer needs this to stamp its own participant state before
  // the host has echoed anything back — the id is generated at connect time.
  getClientId(): string | null {
    return this.clientId
  }

  connect(pairingCode: string, displayName?: string): PeerClientConnectResult {
    const offer = parsePairingCode(pairingCode)
    if (!offer) {
      return { ok: false, reason: 'invalid_pairing_code' }
    }
    if (offer.scope !== 'peer') {
      return { ok: false, reason: 'not_a_peer_pairing_code' }
    }
    this.intentionallyClosed = true
    this.handshake.teardown()
    this.rpc.rejectAll(new Error('Reconnecting to a new host'))
    this.offer = offer
    this.displayName = displayName?.trim() || null
    this.clientId = randomUUID()
    this.intentionallyClosed = false
    this.reconnectAttempt = 0
    this.lastErrorReason = null
    this.openConnection()
    return { ok: true }
  }

  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.handshake.teardown()
    this.rpc.rejectAll(new Error('Disconnected'))
    this.terminalStreams.endAll()
    this.presenceStreams.endAll()
    this.offer = null
    this.clientId = null
    this.setState('closed')
  }

  subscribeTerminal(
    terminal: string,
    viewport: { cols: number; rows: number },
    onEvent: (event: PeerTerminalStreamEvent) => void
  ): { ok: true; requestId: string } | { ok: false; reason: string } {
    return this.terminalStreams.subscribe(terminal, viewport, onEvent)
  }

  unsubscribeTerminal(requestId: string): void {
    this.terminalStreams.unsubscribe(requestId)
  }

  sendTerminalInput(requestId: string, data: string): boolean {
    return this.terminalStreams.sendInput(requestId, data)
  }

  resizeTerminalStream(requestId: string, cols: number, rows: number): boolean {
    return this.terminalStreams.resize(requestId, cols, rows)
  }

  async listHostTerminals(): Promise<unknown> {
    const result = await this.rpc.sendRequest('terminal.list', {})
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    return result.result
  }

  // Why: names of other peers subscribed to the same host terminal, shown
  // in RemoteTerminalPanel's status badge area.
  async listTerminalSubscribers(terminal: string): Promise<{ name: string }[]> {
    const result = await this.rpc.sendRequest('terminal.listSubscribers', { terminal })
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    const subscribers = (result.result as { subscribers?: unknown } | null)?.subscribers
    return Array.isArray(subscribers)
      ? subscribers.filter(
          (entry): entry is { name: string } =>
            Boolean(entry) && typeof (entry as { name?: unknown }).name === 'string'
        )
      : []
  }

  subscribePresence(
    terminal: string,
    onEvent: (event: PeerPresenceEvent) => void
  ): { ok: true; requestId: string } | { ok: false; reason: string } {
    return this.presenceStreams.subscribe(terminal, onEvent)
  }

  unsubscribePresence(requestId: string): void {
    this.presenceStreams.unsubscribe(requestId)
  }

  sendPresenceState(terminal: string, state: PeerPresenceState): void {
    this.presenceStreams.send(terminal, state)
  }

  destroy(): void {
    this.disconnect()
  }

  private setState(next: PeerClientConnectionState): void {
    if (this.state === next) {
      return
    }
    this.state = next
    for (const listener of this.statusListeners) {
      listener(this.getStatus())
    }
  }

  private openConnection(): void {
    if (this.intentionallyClosed || !this.offer) {
      return
    }
    this.setState('connecting')
    this.handshake.open(this.offer)
  }

  // Why: post-handshake decrypted JSON envelope dispatch — RPC replies and
  // stream (terminal/presence) messages all arrive here keyed by `id`.
  private handleReadyMessage(message: Record<string, unknown>): void {
    if (typeof message.id !== 'string' || typeof message.ok !== 'boolean') {
      return
    }
    if (this.terminalStreams.tryHandle(message.id, message)) {
      return
    }
    if (this.presenceStreams.tryHandle(message.id, message)) {
      return
    }
    this.rpc.resolve(message.id, message as { ok: boolean; result?: unknown; error?: unknown })
  }

  private handleSocketClosed(code: number, transportError: string | null = null): void {
    this.rpc.rejectAll(new Error('Connection closed'))
    this.terminalStreams.endAll()
    this.presenceStreams.endAll()
    if (this.intentionallyClosed) {
      this.setState('closed')
      return
    }
    if (code === UNAUTHORIZED_CLOSE_CODE) {
      this.lastErrorReason = 'unauthorized'
      this.intentionallyClosed = true
      this.setState('closed')
      return
    }
    if (code === PEER_DUPLICATE_CONNECTION_CLOSE_CODE) {
      // Why: retrying would keep hitting the same rejection until the host
      // issues a new code — latch closed like the unauthorized case instead
      // of burning the reconnect budget on a guaranteed-repeat rejection.
      this.lastErrorReason = 'duplicate_connection'
      this.intentionallyClosed = true
      this.setState('closed')
      return
    }
    if (code === PEER_HOSTING_DISABLED_CLOSE_CODE) {
      // Why: the host turned peer hosting off — retrying is pointless until
      // the user flips it back on, so latch closed instead of reconnecting.
      this.lastErrorReason = 'host_disabled'
      this.intentionallyClosed = true
      this.setState('closed')
      return
    }
    // Why: kept while reconnecting so the UI can say what actually failed —
    // otherwise every transport failure shows as a bare endless "Reconnecting".
    if (transportError) {
      this.lastErrorReason = transportError
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const pastGiveUpCap = this.reconnectAttempt >= GIVE_UP_AFTER_ATTEMPTS
    const delay = pastGiveUpCap
      ? TRICKLE_RECONNECT_DELAY_MS
      : RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!
    if (!pastGiveUpCap) {
      this.reconnectAttempt++
    }
    this.setState('reconnect-wait')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openConnection()
    }, delay)
  }
}
