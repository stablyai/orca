import type { Socket } from 'node:net'
import { readDaemonClientToken } from './daemon-client-token'
import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, DaemonProtocolError, type DaemonEndpointIdentity } from './types'
import {
  armDaemonSocketCloseHandlers,
  connectDaemonSocket,
  waitForDaemonConnectionAttempt
} from './daemon-client-socket-connect'
import { DaemonClientListeners } from './daemon-client-listener-registry'
import { sameDaemonIdentity, sendDaemonHello } from './daemon-client-hello-handshake'
import { DaemonPendingRequests } from './daemon-client-pending-requests'
import {
  attachControlResponseReader,
  attachStreamEventReader
} from './daemon-client-ndjson-readers'
const CONNECT_TIMEOUT_MS = 5000
const CONNECTION_ATTEMPT_WAIT_MS = CONNECT_TIMEOUT_MS * 4
export type DaemonClientOptions = {
  socketPath: string
  tokenPath: string
  protocolVersion?: number
}

export class DaemonClientConnection {
  private socketPath: string

  private tokenPath: string

  private protocolVersion: number

  private clientId = randomUUID()

  protected controlSocket: Socket | null = null

  private streamSocket: Socket | null = null

  protected connected = false

  private disconnectArmed = false

  // Old-socket close events cannot tear down a replacement connection.
  protected connectionGeneration = 0

  // Concurrent pane spawns share their connection attempt.
  private connectingPromise: Promise<void> | null = null

  private connectionAttemptGeneration = 0

  private daemonIdentity: DaemonEndpointIdentity | null = null

  private daemonResizeModel: string | null | undefined

  private observedAuthenticatedDisconnect = false

  protected pendingRequests = new DaemonPendingRequests()

  protected eventListeners = new DaemonClientListeners<(event: unknown) => void>()

  protected disconnectedListeners = new DaemonClientListeners<() => void>()

  private cleanupSocketListeners: (() => void) | null = null

  constructor(opts: DaemonClientOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
  }

  isConnected(): boolean {
    return this.connected
  }

  getDaemonIdentity(): DaemonEndpointIdentity | null {
    return this.daemonIdentity ? { ...this.daemonIdentity } : null
  }

  getDaemonResizeModel(): string | null | undefined {
    return this.daemonResizeModel
  }

  hasObservedAuthenticatedDisconnect(): boolean {
    return this.observedAuthenticatedDisconnect
  }

  async ensureConnected(): Promise<void> {
    return this.ensureConnectedWithTimeout(CONNECT_TIMEOUT_MS, false)
  }

  async ensureConnectedWithin(timeoutMs: number): Promise<void> {
    return this.ensureConnectedWithTimeout(timeoutMs, true)
  }

  private async ensureConnectedWithTimeout(
    timeoutMs: number,
    sharedBudget: boolean
  ): Promise<void> {
    if (this.connected) {
      return
    }
    if (this.connectingPromise) {
      // Teardown shares one deadline; normal connects allow separate socket and handshake budgets.
      const waiterTimeoutMs = sharedBudget ? timeoutMs : CONNECTION_ATTEMPT_WAIT_MS
      return waitForDaemonConnectionAttempt(this.connectingPromise, waiterTimeoutMs)
    }

    const attemptGeneration = this.connectionAttemptGeneration
    this.connectingPromise = this.doConnect(timeoutMs, attemptGeneration, sharedBudget)
    try {
      await this.connectingPromise
    } finally {
      this.connectingPromise = null
    }
  }

  private async doConnect(
    timeoutMs: number,
    attemptGeneration: number,
    sharedBudget: boolean
  ): Promise<void> {
    const token = readDaemonClientToken(this.tokenPath)
    const deadlineMs = Date.now() + timeoutMs
    const remainingMs = (): number =>
      sharedBudget ? Math.max(1, deadlineMs - Date.now()) : timeoutMs
    const pendingListenerCleanups: (() => void)[] = []
    const cleanupPendingListeners = (): void => {
      for (const cleanup of pendingListenerCleanups.splice(0)) {
        cleanup()
      }
    }

    try {
      const pendingControlSocket = await connectDaemonSocket(this.socketPath, remainingMs())
      this.assertConnectionAttemptCurrent(attemptGeneration, pendingControlSocket)
      this.controlSocket = pendingControlSocket
      const controlHello = await this.sendHello(this.controlSocket, token, 'control', remainingMs())
      const controlIdentity = controlHello.identity
      this.assertConnectionAttemptCurrent(attemptGeneration, this.controlSocket)
      pendingListenerCleanups.push(
        attachControlResponseReader(
          this.controlSocket,
          (response) => this.pendingRequests.settle(response),
          controlHello.remainder
        )
      )

      const pendingStreamSocket = await connectDaemonSocket(this.socketPath, remainingMs())
      this.assertConnectionAttemptCurrent(attemptGeneration, pendingStreamSocket)
      this.streamSocket = pendingStreamSocket
      const streamHello = await this.sendHello(this.streamSocket, token, 'stream', remainingMs())
      this.assertConnectionAttemptCurrent(attemptGeneration, this.streamSocket)
      if (!sameDaemonIdentity(controlIdentity, streamHello.identity)) {
        throw new DaemonProtocolError('Daemon identity changed during connection')
      }
      const streamReader = attachStreamEventReader(this.streamSocket, streamHello, (event) => {
        this.eventListeners.each((listener) => listener(event))
      })
      pendingListenerCleanups.push(streamReader.detach)

      this.assertConnectionAttemptCurrent(attemptGeneration)
      this.connected = true
      this.observedAuthenticatedDisconnect = false
      this.daemonIdentity = controlIdentity
      this.daemonResizeModel = controlHello.resizeModel
      this.disconnectArmed = true
      this.connectionGeneration++

      const gen = this.connectionGeneration
      pendingListenerCleanups.push(
        armDaemonSocketCloseHandlers(
          this.controlSocket,
          this.streamSocket,
          () => this.handleDisconnect(gen),
          streamReader.drainBuffered
        )
      )
      this.cleanupSocketListeners = cleanupPendingListeners
    } catch (error) {
      cleanupPendingListeners()
      this.controlSocket?.destroy()
      this.streamSocket?.destroy()
      this.controlSocket = null
      this.streamSocket = null
      this.connected = false
      this.daemonIdentity = null
      this.disconnectArmed = false
      throw error
    }
  }

  disconnect(): void {
    this.connectionAttemptGeneration++
    this.connected = false
    this.daemonIdentity = null
    this.disconnectArmed = false
    this.cleanupActiveSocketListeners()

    this.pendingRequests.rejectAll('Disconnected')

    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null
  }

  private assertConnectionAttemptCurrent(attemptGeneration: number, socket?: Socket): void {
    if (attemptGeneration === this.connectionAttemptGeneration) {
      return
    }
    socket?.destroy()
    throw new DaemonProtocolError('Disconnected')
  }

  private sendHello(
    socket: Socket,
    token: string,
    role: 'control' | 'stream',
    timeoutMs: number
  ): ReturnType<typeof sendDaemonHello> {
    return sendDaemonHello({
      socket,
      token,
      role,
      timeoutMs,
      protocolVersion: this.protocolVersion,
      clientId: this.clientId
    })
  }

  protected handleDisconnect(generation: number): void {
    if (!this.disconnectArmed || generation !== this.connectionGeneration) {
      return
    }
    this.disconnectArmed = false
    this.connectionAttemptGeneration++
    if (this.daemonIdentity) {
      this.observedAuthenticatedDisconnect = true
    }
    this.connected = false
    this.daemonIdentity = null
    this.daemonResizeModel = null
    this.cleanupActiveSocketListeners()

    this.pendingRequests.rejectAll('Connection lost')

    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null

    this.disconnectedListeners.each((listener) => listener())
  }

  private cleanupActiveSocketListeners(): void {
    const cleanup = this.cleanupSocketListeners
    this.cleanupSocketListeners = null
    cleanup?.()
  }
}
