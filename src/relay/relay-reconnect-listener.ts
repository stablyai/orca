import type { Socket } from 'node:net'
import type { RelayDispatcher } from './dispatcher'
import { setupDaemonHandshake } from './relay-handshake'
import { relayLogLine } from './relay-diagnostic-log'
import type { RelaySocketOwnership } from './relay-socket-ownership'

type RelayReconnectCallbacks = {
  detachPrimaryInput: () => void
  cancelGrace: (reason: string) => void
  onLastClientClosed: () => void
}

export class RelayReconnectListener {
  private readonly socketClients = new Map<Socket, number>()
  private acceptedSocketConnections = 0
  private acceptedSocketClient = false

  constructor(
    private readonly dispatcher: RelayDispatcher,
    readonly ownership: RelaySocketOwnership,
    private readonly launchVersion: string,
    private readonly endpointCredential: string | undefined,
    private readonly callbacks: RelayReconnectCallbacks
  ) {}

  get clientCount(): number {
    return this.socketClients.size
  }

  get hasAcceptedClient(): boolean {
    return this.acceptedSocketClient
  }

  get acceptedConnections(): number {
    return this.acceptedSocketConnections
  }

  async start(): Promise<void> {
    await this.ownership.listen((socket) => this.acceptConnection(socket))
  }

  private acceptConnection(socket: Socket): void {
    setupDaemonHandshake(socket, {
      launchVersion: this.launchVersion,
      endpointCredential: this.endpointCredential,
      onAccepted: (acceptedSocket, leftover) => this.attachAcceptedSocket(acceptedSocket, leftover)
    })
    socket.on('end', () => {
      if (!socket.destroyed) {
        socket.destroy()
      }
    })
    socket.on('error', () => {
      // The close event owns client cleanup and grace startup.
    })
    socket.on('close', () => this.handleSocketClose(socket))
  }

  private attachAcceptedSocket(socket: Socket, leftover: Buffer): void {
    this.callbacks.detachPrimaryInput()
    this.acceptedSocketClient = true
    this.acceptedSocketConnections++
    relayLogLine(
      `[relay] Socket client accepted (clients=${this.socketClients.size + 1}, accepted=${this.acceptedSocketConnections})`
    )
    this.callbacks.cancelGrace('socket client accepted')

    const drainWaiters = new Set<() => void>()
    const flushDrainWaiters = (): void => {
      for (const callback of Array.from(drainWaiters)) {
        drainWaiters.delete(callback)
        callback()
      }
    }
    socket.on('drain', flushDrainWaiters)
    socket.on('close', flushDrainWaiters)
    socket.on('error', flushDrainWaiters)
    const clientId = this.dispatcher.attachClient(
      (data, onSettled) => {
        if (!socket.destroyed) {
          return socket.write(data, (error) => {
            onSettled(error ? { ok: false, error } : { ok: true })
          })
        }
        onSettled({ ok: false, error: new Error('Relay socket is closed') })
        return false
      },
      {
        supportsWriteCallback: true,
        writableLength: () => socket.writableLength,
        writableHighWaterMark: () => socket.writableHighWaterMark,
        close: () => socket.destroy(),
        waitWriteDrain: (callback) => {
          if (socket.destroyed) {
            callback()
            return
          }
          drainWaiters.add(callback)
          return () => drainWaiters.delete(callback)
        }
      },
      {
        principal: `relay-endpoint:${this.launchVersion}`,
        authenticated: this.endpointCredential !== undefined,
        allowSessionOwner: this.endpointCredential !== undefined,
        authenticationKind: this.endpointCredential ? 'endpoint-credential' : 'unproved'
      },
      { pauseReads: () => socket.pause(), resumeReads: () => socket.resume() }
    )
    this.socketClients.set(socket, clientId)
    if (leftover.length > 0) {
      this.dispatcher.feedClient(clientId, leftover)
    }
    socket.on('data', (chunk: Buffer) => {
      this.callbacks.cancelGrace('socket client data')
      this.dispatcher.feedClient(clientId, chunk)
    })
  }

  private handleSocketClose(socket: Socket): void {
    const clientId = this.socketClients.get(socket)
    this.socketClients.delete(socket)
    if (clientId !== undefined) {
      this.dispatcher.detachClient(clientId, 'peer-closed')
    }
    relayLogLine(`[relay] Socket client closed (clients=${this.socketClients.size})`)
    if (this.socketClients.size === 0) {
      this.callbacks.onLastClientClosed()
    }
  }
}
