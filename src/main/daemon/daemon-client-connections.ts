import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { isDaemonRequestFrame, isHelloFrame } from './daemon-client-frame-guards'
import type { DaemonFileLog } from './daemon-file-log'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser, encodeNdjson } from './ndjson'
import { BINARY_STREAM_FRAMING, type DaemonStreamFraming } from './daemon-stream-binary-framing'
import type { DaemonRequest } from './types'

// Idle time before the first probe. How long the close then takes is the OS's probe schedule, not
// ours, which is why the producer-stall watchdog never waits on it.
const STREAM_SOCKET_KEEPALIVE_DELAY_MS = 30_000

export type ConnectedDaemonClient = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
  /** Set per stream socket by its hello; absent means NDJSON. */
  streamFraming?: DaemonStreamFraming
  authenticatedPairEstablished: boolean
}

type DaemonClientConnectionOptions = {
  token: string
  protocolVersion: number
  identity: {
    launchNonce: string | null
    startedAtMs: number | null
    entryPath: string | null
    appVersion: string | null
    spawnerExecPath: string | null
  }
  log: DaemonFileLog
  streamDataBatcher: DaemonStreamDataBatcher
  isAcceptingWork: () => boolean
  onTransportChanged: () => void
  onConnectionAccepted: () => void
  onAuthenticatedPair: () => void
  onLastAuthenticatedClientDisconnected: () => void
  onControlRequest: (socket: Socket, clientId: string, request: DaemonRequest) => void
  onControlReplaced: (clientId: string) => void
  onClientDisconnected: (clientId: string) => void
  onStreamDisconnected: (clientId: string) => void
}

export class DaemonClientConnections {
  private readonly clients = new Map<string, ConnectedDaemonClient>()
  private readonly transportSockets = new Set<Socket>()

  constructor(private readonly options: DaemonClientConnectionOptions) {}

  accept(socket: Socket): void {
    this.options.onConnectionAccepted()
    this.transportSockets.add(socket)
    socket.once('close', () => {
      this.transportSockets.delete(socket)
      this.options.onTransportChanged()
    })
    socket.on('error', () => socket.destroy())

    if (!this.options.isAcceptingWork()) {
      socket.end(
        encodeNdjson({
          type: 'hello',
          ok: false,
          error: 'Daemon temporarily unavailable; reconnect',
          retryable: true
        })
      )
      return
    }
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (message) => this.handleFirstMessage(socket, message),
      () => socket.destroy()
    )
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
  }

  get(clientId: string): ConnectedDaemonClient | undefined {
    return this.clients.get(clientId)
  }

  values(): IterableIterator<ConnectedDaemonClient> {
    return this.clients.values()
  }

  get size(): number {
    return this.clients.size
  }

  get transportCount(): number {
    return this.transportSockets.size
  }

  hasOnlyTransportsFor(client: ConnectedDaemonClient): boolean {
    return [...this.transportSockets].every(
      (transport) => transport === client.controlSocket || transport === client.streamSocket
    )
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.controlSocket.destroy()
      client.streamSocket?.destroy()
    }
    this.clients.clear()
    for (const socket of this.transportSockets) {
      socket.destroy()
    }
    this.transportSockets.clear()
  }

  private handleFirstMessage(socket: Socket, message: unknown): void {
    if (!isHelloFrame(message)) {
      this.options.log.log('client-hello-rejected', { reason: 'expected-hello' })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }
    const hello = message
    if (hello.version !== this.options.protocolVersion) {
      this.options.log.log('client-hello-rejected', {
        reason: 'protocol-mismatch',
        clientVersion: hello.version
      })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Protocol version mismatch' }))
      socket.destroy()
      return
    }
    if (hello.token !== this.options.token) {
      this.options.log.log('client-hello-rejected', { reason: 'invalid-token', role: hello.role })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }))
      socket.destroy()
      return
    }
    if (hello.role !== 'control' && hello.role !== 'stream') {
      this.options.log.log('client-hello-rejected', {
        reason: 'invalid-role',
        role: hello.role
      })
      socket.end(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid role' }))
      return
    }

    const streamFraming: DaemonStreamFraming =
      hello.role === 'stream' && hello.streamFraming === BINARY_STREAM_FRAMING
        ? BINARY_STREAM_FRAMING
        : 'ndjson'
    this.options.log.log('client-hello-accepted', {
      role: hello.role,
      clientId: hello.clientId,
      ...(hello.role === 'stream' ? { streamFraming } : {})
    })
    const identity = this.options.identity
    socket.write(
      encodeNdjson({
        type: 'hello',
        ok: true,
        // Why: this hello line is the socket's last NDJSON; the client switches readers on this field.
        ...(streamFraming === BINARY_STREAM_FRAMING ? { streamFraming } : {}),
        ...(identity.launchNonce && identity.startedAtMs
          ? {
              daemonIdentity: {
                pid: process.pid,
                startedAtMs: identity.startedAtMs,
                launchNonce: identity.launchNonce,
                ...(identity.entryPath ? { entryPath: identity.entryPath } : {}),
                ...(identity.appVersion ? { appVersion: identity.appVersion } : {}),
                ...(identity.spawnerExecPath ? { spawnerExecPath: identity.spawnerExecPath } : {})
              }
            }
          : {})
      })
    )

    if (hello.role === 'control') {
      this.installControlSocket(socket, hello.clientId)
      return
    }
    if (hello.role === 'stream') {
      const client = this.clients.get(hello.clientId)
      if (!client) {
        socket.destroy()
        return
      }
      this.installStreamSocket(socket, client, streamFraming)
      client.authenticatedPairEstablished = true
      this.options.onAuthenticatedPair()
      return
    }
    // The guard checks only that role is a string; anything else was answered above.
    socket.destroy()
  }

  private installControlSocket(socket: Socket, clientId: string): void {
    const previous = this.clients.get(clientId)
    const client: ConnectedDaemonClient = {
      clientId,
      controlSocket: socket,
      streamSocket: null,
      authenticatedPairEstablished: false
    }
    this.clients.set(clientId, client)
    this.setupControlParser(socket, clientId)
    if (!previous) {
      return
    }
    this.options.onControlReplaced(clientId)
    this.recordFullyAuthenticatedDisconnect(previous.authenticatedPairEstablished)
    previous.streamSocket?.destroy()
    previous.controlSocket.destroy()
  }

  private setupControlParser(socket: Socket, clientId: string): void {
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (message) => {
        if (isDaemonRequestFrame(message)) {
          this.options.onControlRequest(socket, clientId, message)
          return
        }
        // Unroutable without an id, so no reply is possible; drop only this connection.
        this.options.log.log('client-frame-rejected', { clientId })
        socket.destroy()
      },
      () => {}
    )
    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
    socket.on('close', () => {
      const client = this.clients.get(clientId)
      if (client?.controlSocket !== socket) {
        return
      }
      this.options.onClientDisconnected(clientId)
      const wasFullyAuthenticated = client.authenticatedPairEstablished
      client.streamSocket?.destroy()
      this.clients.delete(clientId)
      this.recordFullyAuthenticatedDisconnect(wasFullyAuthenticated)
      this.options.onTransportChanged()
    })
  }

  private recordFullyAuthenticatedDisconnect(wasFullyAuthenticated: boolean): void {
    if (
      wasFullyAuthenticated &&
      ![...this.clients.values()].some((client) => client.authenticatedPairEstablished) &&
      this.options.isAcceptingWork()
    ) {
      this.options.onLastAuthenticatedClientDisconnected()
    }
  }

  private installStreamSocket(
    socket: Socket,
    client: ConnectedDaemonClient,
    streamFraming: DaemonStreamFraming
  ): void {
    const previous = client.streamSocket
    socket.removeAllListeners('data')
    // A half-open peer (slept laptop, dropped NAT state) stops draining without closing, which would
    // otherwise hold a session's producer pause open with no event to release it. Kernel probes give
    // that peer a close. TCP only: a no-op over a local pipe, and over SSH it is the relay's own link
    // that dies — the producer-stall watchdog, not this, is what bounds those.
    socket.setKeepAlive(true, STREAM_SOCKET_KEEPALIVE_DELAY_MS)
    client.streamSocket = socket
    client.streamFraming = streamFraming
    socket.on('drain', () => this.options.streamDataBatcher.flush(client.clientId))
    const cleanup = (): void => {
      socket.removeListener('close', cleanup)
      socket.removeListener('error', cleanup)
      if (this.clients.get(client.clientId) !== client || client.streamSocket !== socket) {
        return
      }
      this.options.onStreamDisconnected(client.clientId)
      client.streamSocket = null
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
    if (previous && previous !== socket) {
      previous.destroy()
      this.options.streamDataBatcher.replaceStream(client.clientId)
      this.options.streamDataBatcher.flush(client.clientId)
    }
  }
}
