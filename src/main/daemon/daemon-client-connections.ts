import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type { DaemonFileLog } from './daemon-file-log'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser, encodeNdjson } from './ndjson'
import type { DaemonRequest, HelloMessage } from './types'

export type ConnectedDaemonClient = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
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

/**
 * The minimum a control frame must carry to be routable: an `id` the reply can be
 * correlated against. Anything else is undispatchable, not merely unknown — an unknown
 * method still gets an error reply, but only if we know where to send it.
 *
 * The narrowing asserts *routability, not method validity*, and stopping at `id` is
 * deliberate: `type` belongs to `DaemonRequestRouter.route`, which ends its switch with
 * `throw new Error('Unknown request type: …')` and so answers a bad method with a reply.
 * Checking `type` here would demote that reply to a silent drop, which is the one outcome
 * a client cannot debug.
 */
export function isDispatchableRequest(message: unknown): message is DaemonRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { id?: unknown }).id === 'string' &&
    (message as { id: string }).id.length > 0
  )
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
    // The same unchecked cast as the control parser had, one frame earlier and before any
    // token is checked: `JSON.parse('null')` is a valid frame, and reading `.type` off it
    // threw synchronously inside the socket's `data` handler — an uncaught exception, so
    // the daemon died before it could reject the hello.
    if (typeof message !== 'object' || message === null) {
      this.options.log.log('client-hello-rejected', { reason: 'not-an-object' })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }
    const hello = message as HelloMessage
    if (hello.type !== 'hello') {
      this.options.log.log('client-hello-rejected', { reason: 'expected-hello' })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }
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

    this.options.log.log('client-hello-accepted', { role: hello.role, clientId: hello.clientId })
    const identity = this.options.identity
    socket.write(
      encodeNdjson({
        type: 'hello',
        ok: true,
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
      this.installStreamSocket(socket, client)
      client.authenticatedPairEstablished = true
      this.options.onAuthenticatedPair()
      return
    }
    // Parsed wire data is not made safe by the HelloMessage assertion above.
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
        // `as DaemonRequest` asserted a shape nothing had checked: the parser hands through
        // any parsed JSON, `null` included. One frame without a usable `id` was enough to
        // take the daemon down — and the daemon is the process kept alive precisely so
        // terminals outlive everything else. Dropping is the only correlatable answer,
        // since a reply needs the id the frame did not carry.
        if (!isDispatchableRequest(message)) {
          this.options.log.log('control-frame-dropped', {
            clientId,
            reason: 'missing-or-invalid-id'
          })
          return
        }
        this.options.onControlRequest(socket, clientId, message)
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

  private installStreamSocket(socket: Socket, client: ConnectedDaemonClient): void {
    const previous = client.streamSocket
    socket.removeAllListeners('data')
    client.streamSocket = socket
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
    }
  }
}
