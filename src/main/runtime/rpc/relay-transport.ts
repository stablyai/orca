import WebSocket, { type RawData } from 'ws'
import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'
import type { RpcTransport } from './transport'
import type { MobileSocketTransport, MobileSocketTransportMetadata } from './mobile-socket-wiring'

const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024
// Why: terminate() normally emits 'close' within one tick; 5s covers slow
// teardown without letting a dead socket hold stop() (and app quit) hostage.
export const RELAY_SOCKET_CLOSE_TIMEOUT_MS = 5_000
const RELAY_SOCKET_CLOSE_WAIT_CONCURRENCY = 32

type RelayMessagePayload = string | Uint8Array<ArrayBufferLike>

export type RelayConnectionOpen = {
  connId: string
  connTicket: string
  kind: 'invite' | 'resume'
  relayDeviceId: string
  attachDeadlineMs: number
}

type CloudRelayTransportOptions = {
  cellUrl: string
  relayHostId: string
  generation: number
  createSocket?: (url: string) => WebSocket
  onConnectionClosed?: (connectionId: string) => void
}

function relayWebSocketOrigin(cellUrl: string): string {
  const url = new URL(cellUrl)
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('relay_cell_url_must_be_an_origin')
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else {
    throw new Error('relay_cell_url_must_use_http')
  }
  return url.origin
}

export class CloudRelayTransport implements RpcTransport, MobileSocketTransport {
  private readonly cellWebSocketOrigin: string
  private readonly relayHostId: string
  private generation: number
  private readonly createSocket: (url: string) => WebSocket
  private readonly onConnectionClosed: ((connectionId: string) => void) | undefined
  private readonly socketsByConnectionId = new Map<string, WebSocket>()
  private readonly metadataBySocket = new Map<WebSocket, MobileSocketTransportMetadata>()
  private readonly clientIds = new Map<WebSocket, string>()
  private readonly detachListenersBySocket = new Map<WebSocket, () => void>()
  private readonly closeWaitsBySocket = new Map<WebSocket, Promise<void>>()
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  private closeHandler: Parameters<MobileSocketTransport['onConnectionClose']>[0] | null = null
  private stopped = false

  constructor(options: CloudRelayTransportOptions) {
    this.cellWebSocketOrigin = relayWebSocketOrigin(options.cellUrl)
    this.relayHostId = options.relayHostId
    this.generation = options.generation
    this.onConnectionClosed = options.onConnectionClosed
    this.createSocket =
      options.createSocket ??
      ((url) =>
        new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_RELAY_MESSAGE_BYTES }))
  }

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]): void {
    this.closeHandler = handler
  }

  metadataFor(ws: WebSocket): MobileSocketTransportMetadata {
    const metadata = this.metadataBySocket.get(ws)
    if (!metadata) {
      throw new Error('unknown_relay_socket')
    }
    return metadata
  }

  setClientId(ws: WebSocket, clientId: string): void {
    if (this.metadataBySocket.has(ws)) {
      this.clientIds.set(ws, clientId)
    }
  }

  setGeneration(generation: number): void {
    if (generation === this.generation) {
      return
    }
    if (
      this.socketsByConnectionId.size > 0 ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    ) {
      throw new Error('invalid_relay_generation_transition')
    }
    this.generation = generation
  }

  terminateClientConnections(clientId: string): number {
    const sockets = Array.from(this.clientIds.entries())
      .filter(([, candidate]) => candidate === clientId)
      .map(([socket]) => socket)
    for (const socket of sockets) {
      void this.terminateWithinCloseDeadline(socket)
    }
    return sockets.length
  }

  async start(): Promise<void> {
    this.stopped = false
  }

  async stop(): Promise<void> {
    this.stopped = true
    const sockets = [...this.metadataBySocket.keys()]
    await forEachWithConcurrency(sockets, RELAY_SOCKET_CLOSE_WAIT_CONCURRENCY, (socket) =>
      this.terminateWithinCloseDeadline(socket)
    )
  }

  async openConnection(connection: RelayConnectionOpen): Promise<void> {
    if (this.stopped) {
      throw new Error('relay_transport_stopped')
    }
    if (this.socketsByConnectionId.has(connection.connId)) {
      return
    }
    const url = `${this.cellWebSocketOrigin}/v1/host/data/${encodeURIComponent(connection.connId)}`
    const socket = this.createSocket(url)
    const metadata: MobileSocketTransportMetadata = {
      transport: 'relay',
      relayHostId: this.relayHostId,
      relayDeviceId: connection.relayDeviceId,
      basisConnId: connection.connId,
      credentialKind: connection.kind
    }
    this.socketsByConnectionId.set(connection.connId, socket)
    this.metadataBySocket.set(socket, metadata)

    await new Promise<void>((resolve, reject) => {
      let opened = false
      let attached = false
      let finalized = false
      const deadline = setTimeout(() => {
        socket.terminate()
        // Why: attach expiry makes the socket unusable; release it even if terminate never emits close.
        finalize()
        this.quarantineDetachedSocket(socket)
        if (!opened) {
          reject(new Error('relay_host_data_attach_timeout'))
        }
      }, connection.attachDeadlineMs)
      const finalize = (): void => {
        if (finalized) {
          return
        }
        finalized = true
        clearTimeout(deadline)
        this.finalizeConnection(connection.connId, socket)
      }
      const onMessage = (raw: RawData, isBinary: boolean): void => {
        if (this.stopped || finalized) {
          return
        }
        if (!attached) {
          attached = true
          clearTimeout(deadline)
        }
        const message: RelayMessagePayload = isBinary
          ? new Uint8Array(raw as Buffer)
          : raw.toString()
        this.messageHandler?.(
          message,
          (response) => {
            if (!this.stopped && !finalized && socket.readyState === socket.OPEN) {
              socket.send(response)
            }
          },
          socket
        )
      }
      const onOpen = (): void => {
        opened = true
        const networkSocket = (
          socket as unknown as { _socket?: { setNoDelay(value: boolean): void } }
        )._socket
        networkSocket?.setNoDelay(true)
        socket.send(
          JSON.stringify({
            type: 'host-data-auth',
            v: 1,
            connTicket: connection.connTicket,
            generation: this.generation
          })
        )
        resolve()
      }
      const onError = (error: Error): void => {
        if (!opened) {
          finalize()
          reject(error)
        }
      }
      this.detachListenersBySocket.set(socket, () => {
        finalized = true
        socket.off('message', onMessage)
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', finalize)
      })
      socket.on('message', onMessage)
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', finalize)
    })
  }

  private waitForClose(socket: WebSocket): Promise<void> {
    if (socket.readyState === socket.CLOSED) {
      const connectionId = this.connectionIdForSocket(socket)
      if (connectionId) {
        this.finalizeConnection(connectionId, socket)
      }
      return Promise.resolve()
    }
    // Why: a half-open relay socket after system sleep can never emit 'close';
    // an unbounded wait here wedges stop() and blocks app quit (#9447).
    return new Promise((resolve) => {
      const onClose = (): void => {
        clearTimeout(deadline)
        resolve()
      }
      const deadline = setTimeout(() => {
        socket.off('close', onClose)
        const connectionId = this.connectionIdForSocket(socket)
        if (connectionId) {
          this.finalizeConnection(connectionId, socket)
        }
        this.quarantineDetachedSocket(socket)
        resolve()
      }, RELAY_SOCKET_CLOSE_TIMEOUT_MS)
      socket.once('close', onClose)
      if (socket.readyState === socket.CLOSED) {
        onClose()
      }
    })
  }

  private terminateWithinCloseDeadline(socket: WebSocket): Promise<void> {
    const existing = this.closeWaitsBySocket.get(socket)
    if (existing) {
      return existing
    }
    const pending = this.waitForClose(socket)
    this.closeWaitsBySocket.set(socket, pending)
    void pending.then(() => {
      if (this.closeWaitsBySocket.get(socket) === pending) {
        this.closeWaitsBySocket.delete(socket)
      }
    })
    // Why: install the close waiter first because test doubles and native wrappers can close synchronously.
    socket.terminate()
    return pending
  }

  private connectionIdForSocket(socket: WebSocket): string | undefined {
    const metadata = this.metadataBySocket.get(socket)
    return metadata?.transport === 'relay' ? metadata.basisConnId : undefined
  }

  private quarantineDetachedSocket(socket: WebSocket): void {
    if (socket.readyState === socket.CLOSED) {
      return
    }
    // Why: forced cleanup can precede ws's terminal error/close event.
    const swallowLateError = (): void => {}
    const clearQuarantine = (): void => {
      socket.off('error', swallowLateError)
      socket.off('close', clearQuarantine)
    }
    socket.on('error', swallowLateError)
    socket.once('close', clearQuarantine)
  }

  private finalizeConnection(connectionId: string, socket: WebSocket): void {
    if (this.socketsByConnectionId.get(connectionId) !== socket) {
      return
    }
    this.socketsByConnectionId.delete(connectionId)
    this.metadataBySocket.delete(socket)
    this.detachListenersBySocket.get(socket)?.()
    this.detachListenersBySocket.delete(socket)
    const clientId = this.clientIds.get(socket) ?? null
    this.clientIds.delete(socket)
    this.onConnectionClosed?.(connectionId)
    const hasOtherConnections = clientId !== null && [...this.clientIds.values()].includes(clientId)
    this.closeHandler?.(clientId, socket, hasOtherConnections)
  }
}
