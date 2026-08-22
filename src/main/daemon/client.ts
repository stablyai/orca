import type { Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeNdjson } from './ndjson'
import {
  PROTOCOL_VERSION,
  NOTIFY_PREFIX,
  DaemonConnectionLostError,
  DaemonProtocolError
} from './types'
import type { DaemonEndpointIdentity } from './types'
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
import { writeNotifyWithSettlement } from './daemon-client-notify-settlement'
import { requestDaemonRpc } from './daemon-client-rpc-request'

const CONNECT_TIMEOUT_MS = 5000
const CONNECTION_ATTEMPT_WAIT_MS = CONNECT_TIMEOUT_MS * 4
const REQUEST_TIMEOUT_MS = 30000
const NOTIFY_SETTLEMENT_TIMEOUT_MS = 5000

export type DaemonClientOptions = {
  socketPath: string
  tokenPath: string
  protocolVersion?: number
}

export class DaemonClient {
  private socketPath: string
  private tokenPath: string
  private protocolVersion: number
  private clientId = randomUUID()

  private controlSocket: Socket | null = null
  private streamSocket: Socket | null = null
  private connected = false
  private disconnectArmed = false
  // Why: after a disconnect + reconnect (daemon respawn), a stale 'close'
  // event from the old sockets can fire. Without a generation check, that
  // event would tear down the fresh connection. Each doConnect() increments
  // the generation; handleDisconnect ignores events from old generations.
  private connectionGeneration = 0
  // Why: multiple concurrent spawn() calls from simultaneous pane mounts
  // all call ensureConnected(). Without a lock, each starts a separate
  // connection attempt, overwriting sockets and triggering "Connection lost".
  private connectingPromise: Promise<void> | null = null
  private connectionAttemptGeneration = 0
  private daemonIdentity: DaemonEndpointIdentity | null = null
  private observedAuthenticatedDisconnect = false

  private pendingRequests = new DaemonPendingRequests()
  private eventListeners = new DaemonClientListeners<(event: unknown) => void>()
  private disconnectedListeners = new DaemonClientListeners<() => void>()
  private requestCounter = 0
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
      // Why: a normal connection may legitimately consume one timeout for each
      // socket and hello; bounded teardown calls instead keep their one shared budget.
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

  // Why: a missing token must not preempt the connect that proves whether the endpoint is gone.
  private readToken(): string {
    try {
      return readFileSync(this.tokenPath, 'utf-8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  private async doConnect(
    timeoutMs: number,
    attemptGeneration: number,
    sharedBudget: boolean
  ): Promise<void> {
    const token = this.readToken()
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
      // Sequential: control first, then stream
      const pendingControlSocket = await connectDaemonSocket(this.socketPath, remainingMs())
      this.assertConnectionAttemptCurrent(attemptGeneration, pendingControlSocket)
      this.controlSocket = pendingControlSocket
      const controlIdentity = await this.sendHello(
        this.controlSocket,
        token,
        'control',
        remainingMs()
      )
      this.assertConnectionAttemptCurrent(attemptGeneration, this.controlSocket)
      pendingListenerCleanups.push(
        attachControlResponseReader(this.controlSocket, (response) =>
          this.pendingRequests.settle(response)
        )
      )

      const pendingStreamSocket = await connectDaemonSocket(this.socketPath, remainingMs())
      this.assertConnectionAttemptCurrent(attemptGeneration, pendingStreamSocket)
      this.streamSocket = pendingStreamSocket
      const streamIdentity = await this.sendHello(this.streamSocket, token, 'stream', remainingMs())
      this.assertConnectionAttemptCurrent(attemptGeneration, this.streamSocket)
      if (!sameDaemonIdentity(controlIdentity, streamIdentity)) {
        throw new DaemonProtocolError('Daemon identity changed during connection')
      }
      pendingListenerCleanups.push(
        attachStreamEventReader(this.streamSocket, (event) => {
          this.eventListeners.each((listener) => listener(event))
        })
      )

      this.assertConnectionAttemptCurrent(attemptGeneration)
      this.connected = true
      this.observedAuthenticatedDisconnect = false
      this.daemonIdentity = controlIdentity
      this.disconnectArmed = true
      this.connectionGeneration++

      const gen = this.connectionGeneration
      pendingListenerCleanups.push(
        armDaemonSocketCloseHandlers(this.controlSocket, this.streamSocket, () =>
          this.handleDisconnect(gen)
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

  async request<T = unknown>(
    type: string,
    payload: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.connected || !this.controlSocket) {
      // Why: there is no socket to talk on, so this is a transport failure, not a
      // refusal by the daemon — see settleCreateCancellation's caller.
      throw new DaemonConnectionLostError('Not connected')
    }
    const generation = this.connectionGeneration

    return requestDaemonRpc<T>({
      socket: this.controlSocket,
      pendingRequests: this.pendingRequests,
      id: `req-${++this.requestCounter}`,
      type,
      payload,
      timeoutMs,
      ...(signal ? { signal } : {}),
      unmatchedCancelGraceMs: NOTIFY_SETTLEMENT_TIMEOUT_MS,
      onCreateCancellationFailure: () => this.handleDisconnect(generation),
      settleCreateCancellation: (sessionId, requestId) =>
        this.request<{ canceled: boolean }>(
          'cancelCreateOrAttach',
          { sessionId, requestId },
          NOTIFY_SETTLEMENT_TIMEOUT_MS
        )
    })
  }

  // Why: fire-and-forget writes need a local delivery signal to trigger dead-endpoint recovery.
  notify(type: string, payload: unknown): boolean {
    if (!this.connected || !this.controlSocket) {
      return false
    }

    const id = `${NOTIFY_PREFIX}${++this.requestCounter}`
    const msg = { id, type, ...(payload !== undefined ? { payload } : {}) }
    try {
      this.controlSocket.write(encodeNdjson(msg))
      return true
    } catch {
      // Notifications are best-effort; an oversized payload must not tear down the caller.
      return false
    }
  }

  async notifyWithSettlement(
    type: string,
    payload: unknown,
    timeoutMs = NOTIFY_SETTLEMENT_TIMEOUT_MS
  ): Promise<boolean> {
    if (!this.connected || !this.controlSocket) {
      return false
    }

    const id = `${NOTIFY_PREFIX}${++this.requestCounter}`
    const msg = { id, type, ...(payload !== undefined ? { payload } : {}) }
    const socket = this.controlSocket
    const generation = this.connectionGeneration
    return await writeNotifyWithSettlement({
      socket,
      message: msg,
      timeoutMs,
      onUndeliverable: () => {
        if (this.controlSocket === socket && this.connectionGeneration === generation) {
          this.handleDisconnect(generation)
        }
      }
    })
  }

  onEvent(listener: (event: unknown) => void): () => void {
    return this.eventListeners.add(listener)
  }

  onDisconnected(listener: () => void): () => void {
    return this.disconnectedListeners.add(listener)
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
  ): Promise<DaemonEndpointIdentity | null> {
    return sendDaemonHello({
      socket,
      token,
      role,
      timeoutMs,
      protocolVersion: this.protocolVersion,
      clientId: this.clientId
    })
  }

  private handleDisconnect(generation: number): void {
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
