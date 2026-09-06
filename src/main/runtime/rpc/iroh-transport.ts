// Iroh mobile transport: public-key dial + length-prefixed E2EE frames.
// Liveness: rely on QUIC keepalive for the path; reap connections idle for 30s
// (no inbound frames) instead of WS ping/pong via RemoteRuntimeServerHeartbeat.
import type { Endpoint } from '@number0/iroh'
import type { WebSocket } from 'ws'
import type { RpcTransport } from './transport'
import type { MobileSocketTransport } from './mobile-socket-wiring'
import {
  createFrameDecoder,
  decodeIrohFramePayload,
  IROH_MOBILE_RPC_ALPN
} from './iroh-frame-codec'
import { loadOrCreateIrohEndpointSecret } from './iroh-endpoint-secret'
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
  preAuthTimeoutMs?: number
  idleTimeoutMs?: number
  // Why: tests inject a fake bind so CI never loads the native module or opens UDP.
  bindEndpoint?: (
    secretKey: number[],
    alpn: number[]
  ) => Promise<{
    endpoint: Endpoint
    endpointId: string
  }>
}

export class IrohTransport implements RpcTransport, MobileSocketTransport {
  private readonly userDataPath: string
  private readonly bindEndpoint: IrohTransportOptions['bindEndpoint']
  private endpoint: Endpoint | null = null
  private endpointIdValue: string | null = null
  private messageHandler: MessageHandler | null = null
  private connectionCloseHandler:
    | ((clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null = null
  private readonly sockets = new Set<IrohFramedSocket>()
  private readonly clientIds = new Map<IrohFramedSocket, string>()
  private readonly timers: IrohConnectionTimers
  private acceptLoopPromise: Promise<void> | null = null
  private stopped = true

  constructor(options: IrohTransportOptions) {
    this.userDataPath = options.userDataPath
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
    if (!endpoint) {
      return null
    }
    try {
      const addr = endpoint.addr()
      return {
        relayUrl: addr.relayUrl() ?? null,
        // Why: cap to keep the QR payload small; iroh ranks LAN addrs first.
        directAddresses: addr.directAddresses().slice(0, 8)
      }
    } catch {
      return null
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void {
    this.connectionCloseHandler = handler
  }

  setClientId(ws: WebSocket, clientId: string): void {
    const socket = ws as unknown as IrohFramedSocket
    if (this.sockets.has(socket)) {
      this.clientIds.set(socket, clientId)
      this.timers.clearPreAuth(socket)
      console.info(`[iroh-transport] authenticated clientId=${clientIdLogLabel(clientId)}`)
    }
  }

  terminateClientConnections(clientId: string): number {
    const targets = Array.from(this.clientIds.entries())
      .filter(([, id]) => id === clientId)
      .map(([socket]) => socket)
    for (const socket of targets) {
      socket.terminate()
    }
    return targets.length
  }

  async start(): Promise<void> {
    if (this.endpoint) {
      return
    }
    this.stopped = false
    const secretKey = loadOrCreateIrohEndpointSecret(this.userDataPath)
    const alpn = Array.from(Buffer.from(IROH_MOBILE_RPC_ALPN))

    let endpoint: Endpoint
    let endpointId: string
    if (this.bindEndpoint) {
      const bound = await this.bindEndpoint(secretKey, alpn)
      endpoint = bound.endpoint
      endpointId = bound.endpointId
    } else {
      // Why: lazy import keeps the native module out of processes that never bind.
      const { Endpoint } = await import('@number0/iroh')
      endpoint = await Endpoint.bind({ secretKey, alpns: [alpn] })
      try {
        await endpoint.online()
        endpointId = endpoint.id().toString()
      } catch (error) {
        // Why: bind() already opened the UDP socket, and this.endpoint is still
        // null — stop() would find nothing to close and leak the port.
        await endpoint.close().catch(() => {})
        throw error
      }
    }
    // Why: a concurrent stop() saw endpoint === null and had nothing to close.
    if (this.stopped) {
      await endpoint.close().catch(() => {})
      return
    }
    this.endpoint = endpoint
    this.endpointIdValue = endpointId

    console.info(`[iroh-transport] endpoint bound id=${this.endpointIdValue}`)
    this.acceptLoopPromise = runIrohAcceptLoop({
      endpoint,
      isStopped: () => this.stopped,
      atCapacity: () => this.sockets.size >= MAX_IROH_CONNECTIONS,
      onConnection: (socket, bi) => this.handleConnection(socket, bi)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const socket of Array.from(this.sockets)) {
      socket.terminate()
    }
    this.sockets.clear()
    this.clientIds.clear()
    const endpoint = this.endpoint
    this.endpoint = null
    this.endpointIdValue = null
    if (endpoint) {
      try {
        await endpoint.close()
      } catch {
        // Endpoint may already be closed.
      }
    }
    if (this.acceptLoopPromise) {
      await this.acceptLoopPromise.catch(() => {})
      this.acceptLoopPromise = null
    }
  }

  private handleConnection(
    socket: IrohFramedSocket,
    bi: { recv: { read: (n: number) => Promise<number[]> } }
  ): void {
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
    socket.on('error', () => {
      finalize('error')
      socket.terminate()
    })

    const decoder = createFrameDecoder({
      onFrame: (payload) => {
        this.timers.armIdle(socket)
        const message = decodeIrohFramePayload(payload)
        this.messageHandler?.(
          message,
          (response) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(response)
            }
          },
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

  private async readLoop(
    bi: { recv: { read: (n: number) => Promise<number[]> } },
    decoder: ReturnType<typeof createFrameDecoder>,
    socket: IrohFramedSocket
  ): Promise<void> {
    try {
      while (socket.readyState === socket.OPEN) {
        const chunk = await bi.recv.read(WRITE_CHUNK_BYTES)
        if (!chunk || chunk.length === 0) {
          break
        }
        decoder.feed(Uint8Array.from(chunk))
      }
    } catch {
      // Peer closed or reset.
    } finally {
      socket.terminate()
    }
  }
}
