// Iroh mobile transport: public-key dial + length-prefixed E2EE frames.
// Liveness: rely on QUIC keepalive for the path; reap connections idle for 30s
// (no authenticated read/write progress) instead of WS ping/pong via RemoteRuntimeServerHeartbeat.
import type { Connection, Endpoint } from '@number0/iroh'
import type { WebSocket } from 'ws'
import { parseIrohRelayUrl } from '../../../shared/iroh-relay-preference'
import type { RpcTransport } from './transport'
import type { MobileSocketTransport } from './mobile-socket-wiring'
import {
  createFrameDecoder,
  decodeIrohFramePayload,
  IROH_MOBILE_RPC_ALPN,
  IROH_MAX_FRAME_BYTES,
  IROH_PRE_AUTH_MAX_FRAME_BYTES
} from './iroh-frame-codec'
import { loadOrCreateIrohEndpointSecret } from './iroh-endpoint-secret'
import { bindIrohEndpoint, readIrohEndpointDialHints } from './iroh-endpoint-bind'
import { runIrohAcceptLoop } from './iroh-accept-loop'
import { IrohConnectionTimers } from './iroh-connection-timers'
import { type IrohFramedSocket, WRITE_CHUNK_BYTES } from './iroh-framed-socket'
import { clientIdLogLabel } from './iroh-connection-log'

const PRE_AUTH_TIMEOUT_MS = 10_000
// Why: ~2× the WS heartbeat interval so a quiet-but-alive peer survives one missed tick.
const IDLE_TIMEOUT_MS = 30_000
const MAX_IROH_CONNECTIONS = 128

type MessagePayload = string | Uint8Array<ArrayBufferLike>
type MessageHandler = {
  bivarianceHack(msg: MessagePayload, reply: (response: string) => void, ws: WebSocket): void
}['bivarianceHack']

export type IrohTransportOptions = {
  userDataPath: string
  relayUrl?: string | null
  preAuthTimeoutMs?: number
  idleTimeoutMs?: number
  // Why: tests inject a fake bind so CI never loads the native module or opens UDP.
  bindEndpoint?: (
    secretKey: number[],
    alpn: number[],
    relayUrl: string | null
  ) => Promise<{
    endpoint: Endpoint
    endpointId: string
  }>
}

export class IrohTransport implements RpcTransport, MobileSocketTransport {
  private readonly userDataPath: string
  private readonly relayUrl: IrohTransportOptions['relayUrl']
  private readonly bindEndpoint: IrohTransportOptions['bindEndpoint']
  private endpoint: Endpoint | null = null
  private endpointIdValue: string | null = null
  private messageHandler: MessageHandler | null = null
  private connectionCloseHandler:
    | ((clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null = null
  private readonly sockets = new Set<IrohFramedSocket>()
  private readonly connections = new Set<Connection>()
  private readonly clientIds = new Map<IrohFramedSocket, string>()
  private readonly timers: IrohConnectionTimers
  private readonly shutdown = new AbortController()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private cancelStart: (() => void) | null = null

  constructor(options: IrohTransportOptions) {
    this.userDataPath = options.userDataPath
    this.relayUrl = options.relayUrl
    this.timers = new IrohConnectionTimers(
      options.preAuthTimeoutMs ?? PRE_AUTH_TIMEOUT_MS,
      options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    )
    this.bindEndpoint = options.bindEndpoint
  }

  get endpointId(): string | null {
    return this.endpointIdValue
  }

  /** Dial hints for pairing offers; null until the endpoint is online. */
  endpointDialHints(): { relayUrl: string | null; directAddresses: string[] } | null {
    const endpoint = this.endpoint
    if (!endpoint || !this.endpointIdValue) {
      return null
    }
    return readIrohEndpointDialHints(endpoint)
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void {
    this.connectionCloseHandler = handler
  }

  /** Authenticate an owned socket, admitting full RPC frames and cancelling its pre-auth deadline. */
  setClientId(ws: WebSocket, clientId: string): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only IrohFramedSockets are registered with this transport, so every ws handed back is one.
    const socket = ws as unknown as IrohFramedSocket
    if (this.sockets.has(socket)) {
      this.clientIds.set(socket, clientId)
      this.timers.clearPreAuth(socket)
      this.refreshAuthenticatedIdle(socket)
      console.info(`[iroh-transport] authenticated clientId=${clientIdLogLabel(clientId)}`)
    }
  }

  /** Terminate every authenticated socket for a revoked client and return the count. */
  terminateClientConnections(clientId: string): number {
    const targets = Array.from(this.clientIds.entries())
      .filter(([, id]) => id === clientId)
      .map(([socket]) => socket)
    for (const socket of targets) {
      socket.terminate()
    }
    return targets.length
  }

  /** Share one startup attempt; shutdown cancels the caller's wait even if native bind stalls. */
  async start(): Promise<void> {
    if (this.shutdown.signal.aborted) {
      return
    }
    if (!this.startPromise) {
      const startup = Promise.withResolvers<void>()
      this.startPromise = startup.promise
      this.cancelStart = startup.resolve
      void this.startEndpoint().then(startup.resolve, startup.reject)
    }
    return this.startPromise
  }

  /** Publish dial hints only after the owned endpoint is online; dispose failed or stale binds. */
  private async startEndpoint(): Promise<void> {
    const relayUrl = parseIrohRelayUrl(this.relayUrl)
    const secretKey = loadOrCreateIrohEndpointSecret(this.userDataPath)
    const alpn = Array.from(Buffer.from(IROH_MOBILE_RPC_ALPN))

    let endpoint: Endpoint
    let endpointId: string | undefined
    if (this.bindEndpoint) {
      const bound = await this.bindEndpoint(secretKey, alpn, relayUrl)
      endpoint = bound.endpoint
      endpointId = bound.endpointId
    } else {
      const bound = await bindIrohEndpoint(secretKey, alpn, relayUrl, this.shutdown.signal)
      if (!bound) {
        return
      }
      endpoint = bound
    }
    if (this.shutdown.signal.aborted) {
      await endpoint.close().catch(() => {})
      return
    }
    // Own the endpoint before online(), which may never settle on an unavailable relay.
    this.endpoint = endpoint
    try {
      await endpoint.online()
      if (this.shutdown.signal.aborted) {
        return
      }
      this.endpointIdValue = endpointId ?? endpoint.id().toString()
      console.info(`[iroh-transport] endpoint bound id=${this.endpointIdValue}`)
      void runIrohAcceptLoop({
        endpoint,
        signal: this.shutdown.signal,
        connections: this.connections,
        atCapacity: (pending) => this.sockets.size + pending >= MAX_IROH_CONNECTIONS,
        onConnection: (socket, bi) => this.handleConnection(socket, bi)
      })
    } catch (error) {
      if (this.endpoint === endpoint) {
        this.endpoint = null
        this.endpointIdValue = null
        await endpoint.close().catch(() => {})
      }
      if (!this.shutdown.signal.aborted) {
        throw error
      }
    }
  }

  /** Share one shutdown operation and prevent any later startup from publishing an endpoint. */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      const stopped = Promise.withResolvers<void>()
      this.stopPromise = stopped.promise
      void this.stopEndpoint().then(stopped.resolve, stopped.reject)
    }
    return this.stopPromise
  }

  /** Cancel startup and close all owned sockets, handshakes and the native endpoint. */
  private async stopEndpoint(): Promise<void> {
    const endpoint = this.endpoint
    this.endpoint = null
    this.endpointIdValue = null
    this.shutdown.abort()
    this.cancelStart?.()
    for (const socket of Array.from(this.sockets)) {
      socket.terminate()
    }
    this.sockets.clear()
    this.clientIds.clear()
    for (const connection of this.connections) {
      try {
        connection.close(0n, [])
      } catch {
        // Already closed.
      }
    }
    this.connections.clear()
    if (endpoint) {
      try {
        await endpoint.close()
      } catch {
        // Endpoint may already be closed.
      }
    }
  }

  /** Attach RPC framing and deadlines, finalizing each accepted socket only once. */
  private handleConnection(
    socket: IrohFramedSocket,
    bi: { recv: { read: (n: number) => Promise<number[]> } }
  ): void {
    if (this.shutdown.signal.aborted) {
      socket.terminate()
      return
    }
    let finalized = false
    let closeReason = 'peer'
    const finalize = (reason?: string): void => {
      if (finalized) {
        return
      }
      finalized = true
      if (reason) {
        closeReason = reason
      }
      this.timers.clearPreAuth(socket)
      this.timers.clearIdle(socket)
      this.sockets.delete(socket)
      const clientId = this.clientIds.get(socket) ?? null
      this.clientIds.delete(socket)
      console.info(
        `[iroh-transport] closed clientId=${clientIdLogLabel(clientId)} reason=${closeReason}`
      )
      const hasOtherConnections =
        clientId !== null && Array.from(this.clientIds.values()).includes(clientId)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: IrohFramedSocket implements the send/close/readyState surface the RPC core uses on a WebSocket.
      this.connectionCloseHandler?.(clientId, socket as unknown as WebSocket, hasOtherConnections)
    }

    this.sockets.add(socket)
    this.timers.armIdle(socket, () => {
      if (this.sockets.has(socket)) {
        finalize('idle')
        socket.terminate()
      }
    })
    this.timers.armPreAuth(socket, () => {
      if (!this.clientIds.has(socket)) {
        finalize('preauth-timeout')
        socket.terminate()
      }
    })

    socket.on('close', () => finalize())
    socket.on('write-progress', () => this.refreshAuthenticatedIdle(socket))
    socket.on('error', () => {
      finalize('error')
      socket.terminate()
    })

    const decoder = createFrameDecoder({
      // Keep the public 128-connection admission bound at 1 MiB per unauthenticated payload.
      maxFrameBytes: () =>
        this.clientIds.has(socket) ? IROH_MAX_FRAME_BYTES : IROH_PRE_AUTH_MAX_FRAME_BYTES,
      onFrame: (payload) => {
        if (this.shutdown.signal.aborted || socket.readyState !== socket.OPEN) {
          return
        }
        const message = decodeIrohFramePayload(payload)
        this.messageHandler?.(
          message,
          (response) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(response)
            }
          },
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: IrohFramedSocket implements the send/close/readyState surface the RPC core uses on a WebSocket.
          socket as unknown as WebSocket
        )
      },
      onOversize: () => {
        finalize('oversize-frame')
        socket.terminate()
      }
    })

    void this.readLoop(bi, decoder, socket)
  }

  /** Only live authenticated sockets can renew their lease through native I/O progress. */
  private refreshAuthenticatedIdle(socket: IrohFramedSocket): void {
    if (
      !this.shutdown.signal.aborted &&
      socket.readyState === socket.OPEN &&
      this.clientIds.has(socket)
    ) {
      this.timers.armIdle(socket)
    }
  }

  /** Feed native chunks until EOF or shutdown, always terminating the socket on exit. */
  private async readLoop(
    bi: { recv: { read: (n: number) => Promise<number[]> } },
    decoder: { feed: (chunk: Uint8Array) => void },
    socket: IrohFramedSocket
  ): Promise<void> {
    try {
      while (socket.readyState === socket.OPEN) {
        const chunk = await bi.recv.read(WRITE_CHUNK_BYTES)
        if (this.shutdown.signal.aborted || socket.readyState !== socket.OPEN || !chunk?.length) {
          break
        }
        this.refreshAuthenticatedIdle(socket)
        decoder.feed(Uint8Array.from(chunk))
      }
    } catch {
      // Peer closed or reset.
    } finally {
      socket.terminate()
    }
  }
}
