/* eslint-disable max-lines -- Why: one class owns the daemon socket protocol, routing, stream fanout, and session lifecycle. */
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFileSync, chmodSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import {
  DAEMON_HANDSHAKE_MAX_LINE_BYTES,
  encodeBoundedNdjson,
  encodeNdjson,
  createNdjsonParser
} from './ndjson'
import { TerminalHost } from './terminal-host'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import {
  BackgroundTransientFactRelay,
  BACKGROUND_STREAM_DROP_ENABLED
} from './daemon-background-transient-facts'
import { extractHiddenStartupRendererQueryData } from '../../shared/terminal-reply-query-extraction'
import {
  recordDaemonStreamBacklogEvent,
  startDaemonStreamBacklogProbe
} from './daemon-stream-backlog-probe'
import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'
import type { SubprocessHandle } from './session'
import { checkPtySpawnHealth } from './pty-subprocess'
import { createNoopDaemonFileLog, type DaemonFileLog } from './daemon-file-log'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import { unlinkOwnedDaemonPidFile, unlinkOwnedDaemonTokenFile } from './daemon-spawner'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  NOTIFY_PREFIX,
  SessionNotFoundError,
  TerminalAttachCanceledError,
  type HelloMessage,
  type DaemonRequest
} from './types'
import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import {
  DAEMON_CONTROL_SOCKET_MAX_BUFFERED_BYTES,
  DAEMON_HANDSHAKE_TIMEOUT_MS,
  DAEMON_MAX_ACTIVE_REQUEST_BYTES,
  DAEMON_MAX_ACTIVE_REQUEST_BYTES_PER_CLIENT,
  DAEMON_MAX_ACTIVE_REQUESTS,
  DAEMON_MAX_ACTIVE_REQUESTS_PER_CLIENT,
  DAEMON_MAX_CONTROL_CLIENTS,
  DAEMON_MAX_STREAM_ATTACHMENTS,
  DAEMON_MAX_TRANSPORT_SOCKETS,
  daemonHelloAdmissionError,
  daemonRequestAdmissionError,
  getBoundedDaemonRequestId
} from './daemon-admission-limits'
import {
  DAEMON_CONTROL_PROCESS_MAX_BUFFERED_BYTES,
  DAEMON_MAX_ACTIVE_RESPONSE_BYTES,
  DAEMON_MAX_ACTIVE_RESPONSE_BYTES_PER_CLIENT,
  DAEMON_MAX_RESPONSE_BYTES,
  daemonResponseReservationBytes
} from './daemon-response-admission'

export type DaemonServerOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  /** Direct-construction seam for protocol fixture tests; production never overrides it. */
  protocolVersion?: number
  onIdleShutdown?: () => void
  /** Direct-construction-only controls; production uses the compiled initial-adoption timeout. */
  initialAdoptionTestConfig?: {
    timeoutMs: number
    clock: {
      setTimeout(callback: () => void, delayMs: number): unknown
      clearTimeout(handle: unknown): void
      now(): number
    }
  }
  ptySpawnHealthCheck?: () => Promise<void>
  preparePtySpawn?: () => Promise<void>
  // Why: login-session death detection (#7936) probes on PTY-exit bursts and fresh app connections.
  onPtySessionExit?: (sessionId: string) => void
  onAuthenticatedClientPair?: () => void
  log?: DaemonFileLog
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
  }) => SubprocessHandle
}

type ConnectedClient = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
  authenticatedPairEstablished: boolean
  activeRequestCount: number
  activeRequestBytes: number
  activeResponseBytes: number
}

type PendingPtySpawnPreparation = {
  canceled: boolean
  // Why: preparations are keyed by sessionId, but a control-socket close must
  // cancel only the disconnecting client's preps, not another client's (F4).
  clientId: string
}

type PendingShutdownReply = {
  start: () => void
}

export class DaemonServer {
  // Why: survive long enough to adopt a first client pair, but don't orphan forever if the parent crashes first.
  private static readonly INITIAL_ADOPTION_TIMEOUT_MS = 2 * 60 * 1000
  private static readonly SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS = 1_000
  private server: Server | null = null
  private token: string
  private host: TerminalHost
  private socketPath: string
  private tokenPath: string
  private pidPath: string | null
  private launchNonce: string | null
  private startedAtMs: number | null
  private protocolVersion: number
  private onIdleShutdown: () => void
  private onAuthenticatedClientPair: () => void
  private ptySpawnHealthCheck: () => Promise<void>
  private preparePtySpawn: () => Promise<void>
  private log: DaemonFileLog
  private transportSockets = new Set<Socket>()
  private activeRequestCount = 0
  private activeRequestBytes = 0
  private activeResponseBytes = 0
  private createOrAttachInFlight = 0
  private idleShutdownState: 'running' | 'idle-shutdown-pending' | 'shutting-down' = 'running'
  private initialAdoptionTimer: unknown | null = null
  private initialAdoptionDeadlineMs: number | null = null
  private retirementRequested = false
  private shutdownPromise: Promise<void> | null = null
  private ordinaryShutdownServerClose: Promise<void> | null = null
  private pendingShutdownReplies = new Map<string, PendingShutdownReply>()
  private initialAdoptionTimeoutMs: number
  private lifecycleClock: NonNullable<DaemonServerOptions['initialAdoptionTestConfig']>['clock']

  private clients = new Map<string, ConnectedClient>()
  private streamDataBatcher = new DaemonStreamDataBatcher(
    (clientId) => this.clients.get(clientId),
    {
      isSessionDroppable: (sessionId) =>
        BACKGROUND_STREAM_DROP_ENABLED && this.transientFactRelay.isBackgrounded(sessionId),
      salvageDroppedData: (dropped) => {
        if (!dropped.includes('\x1b')) {
          return ''
        }
        const extracted = extractHiddenStartupRendererQueryData(dropped, '')
        return (
          extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
        )
      }
    }
  )
  // Facts ride the stream queue as control entries so they hold byte order (else a fact could arrive after the reveal snapshot).
  private transientFactRelay = new BackgroundTransientFactRelay((sessionId, fact) => {
    const clientId = this.streamClientIdBySessionId.get(sessionId)
    if (clientId) {
      this.streamDataBatcher.enqueueControlEvent(clientId, sessionId, {
        type: 'event',
        event: 'transientFact',
        sessionId,
        payload: fact
      })
    }
  })
  private streamClientIdBySessionId = new Map<string, string>()
  private lastInputAtBySessionId = new Map<string, number>()
  private pendingPtySpawnPreparations = new Map<string, Set<PendingPtySpawnPreparation>>()
  private stopStreamBacklogProbe: () => void = () => {}

  // Why: bypass batching within this window so keystroke echo/redraws skip the daemon's fixed batch delay.
  private static readonly INTERACTIVE_OUTPUT_WINDOW_MS = 100
  private static readonly INTERACTIVE_OUTPUT_MAX_CHARS = 1024

  constructor(opts: DaemonServerOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.pidPath = opts.pidPath ?? null
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
    this.launchNonce =
      opts.launchNonce ??
      (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION ? randomUUID() : null)
    this.startedAtMs =
      opts.startedAtMs ??
      (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION
        ? Date.now() - process.uptime() * 1000
        : null)
    this.onIdleShutdown = opts.onIdleShutdown ?? (() => {})
    this.initialAdoptionTimeoutMs =
      opts.initialAdoptionTestConfig?.timeoutMs ?? DaemonServer.INITIAL_ADOPTION_TIMEOUT_MS
    this.lifecycleClock = opts.initialAdoptionTestConfig?.clock ?? {
      setTimeout: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref()
        return timer
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    }
    this.token = randomUUID()
    this.onAuthenticatedClientPair = opts.onAuthenticatedClientPair ?? (() => {})
    this.host = new TerminalHost({
      spawnSubprocess: opts.spawnSubprocess,
      ...(opts.onPtySessionExit ? { onSessionReaped: opts.onPtySessionExit } : {})
    })
    this.ptySpawnHealthCheck = opts.ptySpawnHealthCheck ?? checkPtySpawnHealth
    this.preparePtySpawn = opts.preparePtySpawn ?? (() => Promise.resolve())
    this.stopStreamBacklogProbe = startDaemonStreamBacklogProbe(() => ({
      clients: Array.from(this.clients.values(), (client) => ({
        clientId: client.clientId,
        socketBufferedBytes: client.streamSocket?.writableLength ?? 0,
        batcherQueuedChars: this.streamDataBatcher.queuedCharsForClient(client.clientId)
      })),
      backgroundedSessionIdSuffixes: this.transientFactRelay.backgroundedSessionIdSuffixes()
    }))
    this.log = opts.log ?? createNoopDaemonFileLog()
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket))
      const onListenError = (err: Error): void => {
        reject(err)
      }

      this.server.once('error', onListenError)

      this.server.listen(this.socketPath, () => {
        // Why: drop the startup error listener after bind so it doesn't retain this closure.
        this.server?.off('error', onListenError)
        writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
        try {
          chmodSync(this.socketPath, 0o600)
        } catch {
          // Best-effort on platforms that support it
        }
        if (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
          // Why: a parent crash before the first full client pair must not leave an empty daemon alive forever.
          this.armInitialAdoptionTimeout()
        }
        resolve()
      })
    })
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }
    const serverClose = this.beginOrdinaryShutdownFence()
    this.shutdownPromise = this.finishOrdinaryShutdown(serverClose)
    return this.shutdownPromise
  }

  private beginOrdinaryShutdownFence(): Promise<void> {
    this.idleShutdownState = 'shutting-down'
    this.cancelInitialAdoptionTimer()
    this.ordinaryShutdownServerClose ??= this.beginServerClose()
    return this.ordinaryShutdownServerClose
  }

  private async finishOrdinaryShutdown(serverClose: Promise<void>): Promise<void> {
    this.unlinkOwnedEndpointArtifacts()
    await this.disposeDaemonResources()
    await serverClose
  }

  private unlinkOwnedEndpointArtifacts(): void {
    // Why: ownership checks prevent removing a late replacement's token or PID record.
    unlinkOwnedDaemonTokenFile(this.tokenPath, this.token)
    if (this.pidPath && this.launchNonce) {
      unlinkOwnedDaemonPidFile(this.pidPath, process.pid, this.launchNonce)
    }
  }

  private async disposeDaemonResources(): Promise<void> {
    this.stopStreamBacklogProbe()
    this.transientFactRelay.dispose()
    this.cancelAllPendingPtySpawnPreparations()
    try {
      await this.host.dispose()
    } catch (err) {
      // Why: an unreapable child must not block daemon exit — post-exit it reparents to init anyway.
      this.log.log('shutdown-dispose-failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
    this.streamDataBatcher.clear()
    this.pendingShutdownReplies.clear()

    for (const [, client] of this.clients) {
      client.controlSocket.destroy()
      client.streamSocket?.destroy()
    }
    this.clients.clear()
    for (const socket of this.transportSockets) {
      socket.destroy()
    }
    this.transportSockets.clear()
  }

  private beginServerClose(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      // Why: close synchronously before any awaited cleanup so no new transport enters after the empty proof.
      server.close(() => {
        // Node owns unlinking its Unix listener; an extra unlink here could delete a concurrent replacement.
        resolve()
      })
    })
  }

  private isIdle(): boolean {
    return (
      this.transportSockets.size === 0 &&
      this.clients.size === 0 &&
      this.activeRequestCount === 0 &&
      this.createOrAttachInFlight === 0 &&
      this.host.listSessions().length === 0
    )
  }

  private reevaluateIdleShutdown(): void {
    if (this.idleShutdownState !== 'running') {
      return
    }
    if (this.retirementRequested) {
      this.cancelInitialAdoptionTimer()
      if (this.isIdle()) {
        this.beginIdleShutdown()
      }
      return
    }
    if (!this.isIdle() || this.initialAdoptionDeadlineMs === null) {
      this.cancelInitialAdoptionTimer()
      return
    }
    if (this.initialAdoptionTimer !== null) {
      return
    }
    const remainingMs = Math.max(0, this.initialAdoptionDeadlineMs - this.lifecycleClock.now())
    if (remainingMs === 0) {
      this.initialAdoptionDeadlineMs = null
      this.retirementRequested = true
      this.beginIdleShutdown()
      return
    }
    this.initialAdoptionTimer = this.lifecycleClock.setTimeout(() => {
      this.initialAdoptionTimer = null
      this.initialAdoptionDeadlineMs = null
      this.retirementRequested = true
      this.beginIdleShutdown()
    }, remainingMs)
  }

  private armInitialAdoptionTimeout(): void {
    this.initialAdoptionDeadlineMs = this.lifecycleClock.now() + this.initialAdoptionTimeoutMs
    this.reevaluateIdleShutdown()
  }

  private cancelInitialAdoptionTimer(): void {
    if (this.initialAdoptionTimer === null) {
      return
    }
    this.lifecycleClock.clearTimeout(this.initialAdoptionTimer)
    this.initialAdoptionTimer = null
  }

  private beginIdleShutdown(): void {
    this.initialAdoptionTimer = null
    if (this.idleShutdownState !== 'running') {
      return
    }
    this.idleShutdownState = 'idle-shutdown-pending'
    if (!this.isIdle()) {
      // Why: work admitted before the fence wins; clear pending state to keep it usable.
      this.idleShutdownState = 'running'
      this.reevaluateIdleShutdown()
      return
    }

    this.idleShutdownState = 'shutting-down'
    // beginServerClose() runs synchronously up to server.close() before any yield to a racing connection.
    const serverClose = this.beginServerClose()
    this.shutdownPromise = this.finishIdleShutdown(serverClose)
  }

  private async finishIdleShutdown(serverClose: Promise<void>): Promise<void> {
    this.unlinkOwnedEndpointArtifacts()
    await this.disposeDaemonResources()
    await serverClose
    this.onIdleShutdown()
  }

  private handleConnection(socket: Socket): void {
    socket.on('error', () => socket.destroy())
    if (this.transportSockets.size >= DAEMON_MAX_TRANSPORT_SOCKETS) {
      socket.destroy()
      return
    }

    this.cancelInitialAdoptionTimer()
    this.transportSockets.add(socket)
    const removeTransport = (): void => {
      this.transportSockets.delete(socket)
      this.reevaluateIdleShutdown()
    }
    socket.once('close', removeTransport)

    if (this.idleShutdownState !== 'running') {
      // Why: a connection accepted just before close() gets an explicit retry signal instead of dying mid-auth.
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

    let handshakeComplete = false
    const handshakeTimer = setTimeout(() => socket.destroy(), DAEMON_HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref()
    socket.once('close', () => clearTimeout(handshakeTimer))
    // Why: keep UTF-8 sequences intact across socket chunks before NDJSON parsing.
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => {
        if (handshakeComplete) {
          return
        }
        handshakeComplete = true
        clearTimeout(handshakeTimer)
        this.handleFirstMessage(socket, msg)
      },
      () => {
        socket.destroy()
      },
      { maxLineBytes: DAEMON_HANDSHAKE_MAX_LINE_BYTES }
    )

    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
  }

  private handleFirstMessage(socket: Socket, msg: unknown): void {
    const helloError = daemonHelloAdmissionError(msg)
    if (helloError) {
      this.log.log('client-hello-rejected', { reason: 'invalid-hello' })
      this.rejectHello(socket, helloError)
      return
    }
    const hello = msg as HelloMessage

    if (hello.version !== this.protocolVersion) {
      this.log.log('client-hello-rejected', {
        reason: 'protocol-mismatch',
        clientVersion: hello.version
      })
      this.rejectHello(socket, 'Protocol version mismatch')
      return
    }

    if (hello.token !== this.token) {
      this.log.log('client-hello-rejected', { reason: 'invalid-token', role: hello.role })
      this.rejectHello(socket, 'Invalid token')
      return
    }

    const previous = hello.role === 'control' ? this.clients.get(hello.clientId) : undefined
    const streamClient = hello.role === 'stream' ? this.clients.get(hello.clientId) : undefined
    if (hello.role === 'control' && !previous && this.clients.size >= DAEMON_MAX_CONTROL_CLIENTS) {
      this.rejectHello(socket, 'Daemon control-client capacity exceeded; reconnect', true)
      return
    }
    if (
      streamClient &&
      streamClient.streamSocket === null &&
      this.streamAttachmentCount() >= DAEMON_MAX_STREAM_ATTACHMENTS
    ) {
      this.rejectHello(socket, 'Daemon stream-attachment capacity exceeded; reconnect', true)
      return
    }

    this.log.log('client-hello-accepted', { role: hello.role, clientId: hello.clientId })
    socket.write(
      encodeNdjson({
        type: 'hello',
        ok: true,
        ...(this.launchNonce && this.startedAtMs
          ? {
              daemonIdentity: {
                pid: process.pid,
                startedAtMs: this.startedAtMs,
                launchNonce: this.launchNonce
              }
            }
          : {})
      })
    )

    if (hello.role === 'control') {
      const client: ConnectedClient = {
        clientId: hello.clientId,
        controlSocket: socket,
        streamSocket: null,
        authenticatedPairEstablished: false,
        activeRequestCount: 0,
        activeRequestBytes: 0,
        activeResponseBytes: 0
      }
      this.clients.set(hello.clientId, client)
      this.setupControlSocket(socket, hello.clientId)
      if (previous) {
        // Why: reconnect reuses clientId before stale close fires; cancel the old owner's preflight at handoff.
        this.cancelPendingPtySpawnPreparationsForClient(hello.clientId)
        this.recordFullyAuthenticatedDisconnect(previous.authenticatedPairEstablished)
        // Why: tear down the old sockets after installing the new owner so a stale close can't delete the replacement.
        previous.streamSocket?.destroy()
        previous.controlSocket.destroy()
      }
    } else if (streamClient) {
      this.setupStreamSocket(socket, streamClient)
      streamClient.authenticatedPairEstablished = true
      // Why: one-shot health probes authenticate only a control socket; they are not fresh app activity.
      this.onAuthenticatedClientPair()
      // A complete app connection (unlike a probe) re-owns the endpoint and cancels pending retirement.
      this.initialAdoptionDeadlineMs = null
      this.retirementRequested = false
      this.cancelInitialAdoptionTimer()
    } else {
      // Why: preserve the legacy authenticated handshake before dropping a stream with no owner.
      socket.destroy()
    }
  }

  private rejectHello(socket: Socket, error: string, retryable = false): void {
    socket.end(
      encodeNdjson({
        type: 'hello',
        ok: false,
        error,
        ...(retryable ? { retryable: true } : {})
      }),
      () => socket.destroy()
    )
  }

  private streamAttachmentCount(): number {
    let count = 0
    for (const client of this.clients.values()) {
      if (client.streamSocket) {
        count += 1
      }
    }
    return count
  }

  private setupControlSocket(socket: Socket, clientId: string): void {
    // Why: decode as a UTF-8 stream so emoji/Unicode split across chunks isn't corrupted.
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg, lineBytes) => this.dispatchRequest(socket, clientId, msg, lineBytes ?? 0),
      () => socket.destroy(),
      { includeLineBytes: true }
    )

    // Remove the initial data listener and replace with the RPC parser
    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))

    socket.on('close', () => {
      const client = this.clients.get(clientId)
      if (client?.controlSocket !== socket) {
        return
      }
      // Why: a client that disconnects mid-preflight would otherwise still create
      // its daemon PTY, orphaning a durable, unattached session — cancel its preps (F4).
      this.cancelPendingPtySpawnPreparationsForClient(clientId)
      const wasFullyAuthenticated = client.authenticatedPairEstablished
      this.streamDataBatcher.clear(clientId)
      client.streamSocket?.destroy()
      this.clients.delete(clientId)
      this.recordFullyAuthenticatedDisconnect(wasFullyAuthenticated)
      this.reevaluateIdleShutdown()
    })
  }

  private recordFullyAuthenticatedDisconnect(wasFullyAuthenticated: boolean): void {
    if (
      !wasFullyAuthenticated ||
      [...this.clients.values()].some((remaining) => remaining.authenticatedPairEstablished) ||
      this.idleShutdownState !== 'running'
    ) {
      return
    }
    // Why: once the last full client is gone, incomplete transports may block retirement but never erase it.
    this.retirementRequested = true
  }

  private setupStreamSocket(socket: Socket, client: ConnectedClient): void {
    const previous = client.streamSocket
    socket.removeAllListeners('data')
    client.streamSocket = socket
    // Why: 'drain' is the wake-up for the batcher's shallow-gate held bulk.
    socket.on('drain', () => {
      this.streamDataBatcher.flush(client.clientId)
    })

    const cleanup = (): void => {
      socket.removeListener('close', cleanup)
      socket.removeListener('error', cleanup)
      if (this.clients.get(client.clientId) !== client || client.streamSocket !== socket) {
        return
      }
      // Why: a preflight that outlives its output channel would create an unattached daemon PTY.
      this.cancelPendingPtySpawnPreparationsForClient(client.clientId)
      this.streamDataBatcher.clear(client.clientId)
      client.streamSocket = null
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)

    if (previous && previous !== socket) {
      // Why: replacing a stream socket must not leave the old channel alive and untracked.
      previous.destroy()
    }
  }

  private dispatchRequest(
    socket: Socket,
    clientId: string,
    value: unknown,
    lineBytes: number
  ): void {
    const client = this.clients.get(clientId)
    if (!client || client.controlSocket !== socket) {
      return
    }

    const requestId = getBoundedDaemonRequestId(value)
    const admissionError = daemonRequestAdmissionError(value)
    if (admissionError) {
      this.writeRequestError(socket, requestId, admissionError)
      return
    }
    const request = value as DaemonRequest
    const responseReservationBytes = daemonResponseReservationBytes(request)
    if (
      client.activeRequestCount >= DAEMON_MAX_ACTIVE_REQUESTS_PER_CLIENT ||
      this.activeRequestCount >= DAEMON_MAX_ACTIVE_REQUESTS ||
      client.activeRequestBytes + lineBytes > DAEMON_MAX_ACTIVE_REQUEST_BYTES_PER_CLIENT ||
      this.activeRequestBytes + lineBytes > DAEMON_MAX_ACTIVE_REQUEST_BYTES ||
      client.activeResponseBytes + responseReservationBytes >
        DAEMON_MAX_ACTIVE_RESPONSE_BYTES_PER_CLIENT ||
      this.activeResponseBytes + responseReservationBytes > DAEMON_MAX_ACTIVE_RESPONSE_BYTES
    ) {
      this.writeRequestError(socket, request.id, 'Daemon request capacity exceeded; retry')
      return
    }

    client.activeRequestCount += 1
    client.activeRequestBytes += lineBytes
    this.activeRequestCount += 1
    this.activeRequestBytes += lineBytes
    client.activeResponseBytes += responseReservationBytes
    this.activeResponseBytes += responseReservationBytes
    void this.handleRequest(socket, clientId, request).finally(() => {
      client.activeRequestCount -= 1
      client.activeRequestBytes -= lineBytes
      this.activeRequestCount -= 1
      this.activeRequestBytes -= lineBytes
      client.activeResponseBytes -= responseReservationBytes
      this.activeResponseBytes -= responseReservationBytes
      this.reevaluateIdleShutdown()
    })
  }

  private writeRequestError(socket: Socket, requestId: string | null, error: string): void {
    if (!requestId || requestId.startsWith(NOTIFY_PREFIX)) {
      return
    }
    this.writeControlMessage(socket, { id: requestId, ok: false, error })
  }

  private writeControlMessage(socket: Socket, message: unknown, onFlushed?: () => void): void {
    const encoded = encodeBoundedNdjson(message, DAEMON_MAX_RESPONSE_BYTES)
    const encodedBytes = Buffer.byteLength(encoded, 'utf8')
    if (
      socket.writableLength + encodedBytes > DAEMON_CONTROL_SOCKET_MAX_BUFFERED_BYTES ||
      this.controlSocketBufferedBytes() + encodedBytes > DAEMON_CONTROL_PROCESS_MAX_BUFFERED_BYTES
    ) {
      socket.destroy()
      return
    }
    socket.write(encoded, onFlushed)
  }

  private controlSocketBufferedBytes(): number {
    let total = 0
    for (const client of this.clients.values()) {
      total += Math.max(0, client.controlSocket.writableLength)
      if (total > DAEMON_CONTROL_PROCESS_MAX_BUFFERED_BYTES) {
        break
      }
    }
    return total
  }

  private async handleRequest(
    socket: Socket,
    clientId: string,
    request: DaemonRequest
  ): Promise<void> {
    const isNotify = request.id.startsWith(NOTIFY_PREFIX)

    try {
      const result = await this.routeRequest(clientId, request)
      if (!isNotify) {
        const pendingShutdown = this.pendingShutdownReplies.get(
          this.shutdownReplyKey(clientId, request.id)
        )
        this.writeControlMessage(socket, { id: request.id, ok: true, payload: result }, () => {
          pendingShutdown?.start()
        })
      }
    } catch (err) {
      if (!isNotify) {
        this.writeControlMessage(socket, {
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  private shutdownReplyKey(clientId: string, requestId: string): string {
    return `${clientId}\u0000${requestId}`
  }

  private deferShutdownUntilReply(
    clientId: string,
    requestId: string,
    socket: Socket,
    finish: () => Promise<void>
  ): void {
    const key = this.shutdownReplyKey(clientId, requestId)
    let started = false
    let timer: ReturnType<typeof setTimeout>
    const start = (): void => {
      if (started) {
        return
      }
      started = true
      clearTimeout(timer)
      socket.off('close', start)
      socket.off('error', start)
      this.pendingShutdownReplies.delete(key)
      if (!this.shutdownPromise) {
        this.shutdownPromise = finish()
      }
    }
    // Why: a non-reading peer must not pin a fenced daemon by holding its ack behind permanent socket backpressure.
    timer = setTimeout(start, DaemonServer.SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS)
    timer.unref()
    socket.once('close', start)
    socket.once('error', start)
    this.pendingShutdownReplies.set(key, { start })
  }

  private async preparePtySpawnUnlessCanceled(sessionId: string, clientId: string): Promise<void> {
    const preparation: PendingPtySpawnPreparation = { canceled: false, clientId }
    const pending = this.pendingPtySpawnPreparations.get(sessionId) ?? new Set()
    pending.add(preparation)
    this.pendingPtySpawnPreparations.set(sessionId, pending)
    try {
      // Why: register before the async probe so a concurrent close can cancel this creation before a subprocess exists.
      await this.preparePtySpawn()
      if (preparation.canceled) {
        throw new TerminalAttachCanceledError(sessionId)
      }
    } finally {
      pending.delete(preparation)
      if (pending.size === 0) {
        this.pendingPtySpawnPreparations.delete(sessionId)
      }
    }
  }

  private cancelPendingPtySpawnPreparations(sessionId: string): boolean {
    const pending = this.pendingPtySpawnPreparations.get(sessionId)
    if (!pending) {
      return false
    }
    for (const preparation of pending) {
      preparation.canceled = true
    }
    return true
  }

  private cancelAllPendingPtySpawnPreparations(): void {
    for (const sessionId of this.pendingPtySpawnPreparations.keys()) {
      this.cancelPendingPtySpawnPreparations(sessionId)
    }
  }

  private cancelPendingPtySpawnPreparationsForClient(clientId: string): void {
    for (const pending of this.pendingPtySpawnPreparations.values()) {
      for (const preparation of pending) {
        if (preparation.clientId === clientId) {
          preparation.canceled = true
        }
      }
    }
  }

  private async routeRequest(clientId: string, request: DaemonRequest): Promise<unknown> {
    const client = this.clients.get(clientId)

    switch (request.type) {
      case 'createOrAttach': {
        if (this.idleShutdownState !== 'running') {
          throw new Error('Daemon temporarily unavailable; reconnect')
        }
        if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
          // Why: a control-only replacement can't own terminal admission or erase the prior client's retirement request.
          throw new Error('Daemon client connection is incomplete; reconnect')
        }
        this.createOrAttachInFlight++
        const p = request.payload
        let routedSessionId = p.sessionId
        let result: Awaited<ReturnType<TerminalHost['createOrAttach']>>
        try {
          if (
            p.agentSessionEnsure !== undefined &&
            (!isAgentSessionExecutionClaim(p.agentSessionEnsure.claim) ||
              !isAgentSessionSurfaceBinding(p.agentSessionEnsure.surface))
          ) {
            throw new Error('agent_session_identity_required')
          }
          await this.preparePtySpawnUnlessCanceled(p.sessionId, clientId)
          result = await this.host.createOrAttach({
            sessionId: p.sessionId,
            cols: p.cols,
            rows: p.rows,
            cwd: p.cwd,
            env: p.env,
            envToDelete: p.envToDelete,
            command: p.command,
            startupCommandDelivery: p.startupCommandDelivery,
            // Why: RPC payloads are untrusted JSON; persist only the allowlisted routing enum, never arbitrary identity.
            ...(isTuiAgent(p.launchAgent) ? { launchAgent: p.launchAgent } : {}),
            shellOverride: p.shellOverride,
            terminalWindowsWslDistro: p.terminalWindowsWslDistro,
            terminalWindowsPowerShellImplementation: p.terminalWindowsPowerShellImplementation,
            shellReadySupported: p.shellReadySupported,
            historySeed: p.historySeed,
            startupIngress: parsePtyStartupIngressIntent(p.startupIngress),
            ...(p.shellReadyTimeoutMs !== undefined
              ? { shellReadyTimeoutMs: p.shellReadyTimeoutMs }
              : {}),
            ...(p.agentSessionEnsure ? { agentSessionEnsure: p.agentSessionEnsure } : {}),
            onSessionResolved: (sessionId) => {
              routedSessionId = sessionId
            },
            streamClient: {
              onData: (data, rawLength = data.length, transformed = false, seq) => {
                // Scan BEFORE enqueue: the batcher may drop this chunk, but its facts must be captured regardless.
                this.transientFactRelay.onSessionData(routedSessionId, data)
                const lastInputAt = this.lastInputAtBySessionId.get(routedSessionId)
                const isInteractiveOutput =
                  data.length <= DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS &&
                  lastInputAt !== undefined &&
                  performance.now() - lastInputAt <= DaemonServer.INTERACTIVE_OUTPUT_WINDOW_MS
                this.streamDataBatcher.enqueue(clientId, routedSessionId, data, {
                  flushImmediately: isInteractiveOutput,
                  flushMaxChars: DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS,
                  rawLength,
                  transformed,
                  seq
                })
              },
              onExit: (code, incarnationId) => {
                // Why: exit tears down renderer handlers, so it must ride the ordered queue behind final output.
                this.log.log('session-exited', { sessionId: routedSessionId, code })
                this.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
                  type: 'event',
                  event: 'exit',
                  sessionId: routedSessionId,
                  payload: { code, incarnationId }
                })
                this.streamDataBatcher.flush(clientId)
                recordDaemonStreamBacklogEvent('sessionExit', {
                  sessionIdSuffix: routedSessionId.slice(-10)
                })
                this.transientFactRelay.onSessionExit(routedSessionId)
                this.streamClientIdBySessionId.delete(routedSessionId)
                this.lastInputAtBySessionId.delete(routedSessionId)
                this.reevaluateIdleShutdown()
              }
            }
          })
        } finally {
          this.createOrAttachInFlight--
          this.reevaluateIdleShutdown()
        }
        routedSessionId = result.agentSessionEnsure?.owner.ptyId ?? p.sessionId
        this.streamClientIdBySessionId.set(routedSessionId, clientId)
        // Why an attach-time marker: background resync can precede this attach, so scan suppression must start at the new stream's head.
        if (this.transientFactRelay.isBackgrounded(routedSessionId)) {
          this.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
            type: 'event',
            event: 'sessionBackgroundMarker',
            sessionId: routedSessionId,
            payload: { background: true }
          })
        }
        this.log.log(result.isNew ? 'session-created' : 'session-attached', {
          sessionId: routedSessionId,
          pid: result.pid
        })
        return {
          isNew: result.isNew,
          snapshot: result.snapshot,
          pid: result.pid,
          shellState: result.shellState,
          incarnationId: result.incarnationId,
          ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
          wslDistro: result.wslDistro,
          ...(result.historySeeded !== undefined ? { historySeeded: result.historySeeded } : {}),
          ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
        }
      }

      case 'cancelCreateOrAttach':
        this.cancelPendingPtySpawnPreparations(request.payload.sessionId)
        return {}

      case 'closeStartupQueryAuthority':
        return {
          appliedSeq: this.host.closeStartupQueryAuthority(request.payload.sessionId)
        }

      case 'write':
        try {
          this.lastInputAtBySessionId.set(request.payload.sessionId, performance.now())
          this.host.write(request.payload.sessionId, request.payload.data)
        } catch (err) {
          this.lastInputAtBySessionId.delete(request.payload.sessionId)
          if (err instanceof SessionNotFoundError) {
            this.sendExitEvent(client, request.payload.sessionId, -1)
          }
          throw err
        }
        return {}

      case 'resize':
        try {
          this.host.resize(request.payload.sessionId, request.payload.cols, request.payload.rows)
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            this.sendExitEvent(client, request.payload.sessionId, -1)
          }
          throw err
        }
        return {}

      case 'pausePty':
        this.host.pauseProducer(request.payload.sessionId)
        return {}

      case 'resumePty':
        this.host.resumeProducer(request.payload.sessionId)
        return {}

      case 'setSessionBackground': {
        const sessionId = request.payload.sessionId
        const background = request.payload.background === true
        recordDaemonStreamBacklogEvent('setSessionBackground', {
          sessionIdSuffix: sessionId.slice(-10),
          background
        })
        if (!this.transientFactRelay.setSessionBackground(sessionId, background)) {
          return {}
        }
        if (background) {
          // Seed the fresh relay tracker with the emulator's dangling escape so a handoff-split sequence still parses.
          this.transientFactRelay.seedSessionScanState(
            sessionId,
            this.host.getPartialEscapeTailAnsi(sessionId)
          )
        }
        const streamClientId = this.streamClientIdBySessionId.get(sessionId)
        if (!streamClientId) {
          // Not attached yet — the attach-time marker covers the handoff.
          return {}
        }
        // Reveal intentionally keeps the queued tail: main needs those bytes, and the normal flush/drain delivers them in order ahead of the marker.
        const scanSeedAnsi = background ? '' : this.host.getPartialEscapeTailAnsi(sessionId)
        this.streamDataBatcher.enqueueControlEvent(streamClientId, sessionId, {
          type: 'event',
          event: 'sessionBackgroundMarker',
          sessionId,
          payload: {
            background,
            ...(scanSeedAnsi.length > 0 ? { scanSeedAnsi } : {})
          }
        })
        return {}
      }

      case 'kill': {
        const canceledPendingSpawn = this.cancelPendingPtySpawnPreparations(
          request.payload.sessionId
        )
        this.lastInputAtBySessionId.delete(request.payload.sessionId)
        this.log.log('session-killed', {
          sessionId: request.payload.sessionId,
          immediate: request.payload.immediate === true
        })
        try {
          await this.host.kill(request.payload.sessionId, { immediate: request.payload.immediate })
        } catch (error) {
          // Why: a kill that wins before session registration already canceled the pending spawn, so its intent is done.
          if (!(canceledPendingSpawn && error instanceof SessionNotFoundError)) {
            throw error
          }
        }
        return {}
      }

      case 'signal':
        this.host.signal(request.payload.sessionId, request.payload.signal)
        return {}

      case 'detach':
        // Note: detach token handling simplified — full impl would track tokens per client
        this.log.log('session-detached', { sessionId: request.payload.sessionId })
        return {}

      case 'getCwd':
        return { cwd: await this.host.getCwd(request.payload.sessionId) }

      case 'getForegroundProcess':
        return { foregroundProcess: this.host.getForegroundProcess(request.payload.sessionId) }

      case 'inspectProcess':
        return this.host.inspectProcess(request.payload.sessionId)

      case 'confirmForegroundProcess':
        return {
          foregroundProcess: await this.host.confirmForegroundProcess(request.payload.sessionId)
        }

      case 'clearScrollback':
        this.host.clearScrollback(request.payload.sessionId)
        return {}

      case 'listSessions':
        return { sessions: this.host.listSessions() }

      case 'shutdownIfIdle': {
        const authenticatedClient = this.clients.get(clientId)
        const retiring =
          authenticatedClient !== undefined &&
          authenticatedClient.streamSocket !== null &&
          this.clients.size === 1 &&
          this.activeRequestCount <= 1 &&
          this.createOrAttachInFlight === 0 &&
          this.host.listSessions().length === 0 &&
          [...this.transportSockets].every(
            (transport) =>
              transport === authenticatedClient.controlSocket ||
              transport === authenticatedClient.streamSocket
          )
        if (!retiring) {
          return { retiring: false }
        }
        this.idleShutdownState = 'shutting-down'
        this.initialAdoptionDeadlineMs = null
        this.retirementRequested = false
        this.cancelInitialAdoptionTimer()
        // Why: close before acknowledging retirement so no new terminal races between the empty proof and disposal.
        const serverClose = this.beginServerClose()
        this.deferShutdownUntilReply(clientId, request.id, authenticatedClient.controlSocket, () =>
          this.finishIdleShutdown(serverClose)
        )
        return { retiring: true }
      }

      case 'getSnapshot': {
        const snapshotStart = performance.now()
        const requestedScrollbackRows = request.payload.scrollbackRows
        const scrollbackRows =
          typeof requestedScrollbackRows === 'number' && Number.isFinite(requestedScrollbackRows)
            ? Math.max(0, Math.min(50_000, Math.floor(requestedScrollbackRows)))
            : undefined
        const snapshot = this.host.getSnapshot(request.payload.sessionId, { scrollbackRows })
        const snapshotMs = performance.now() - snapshotStart
        if (snapshotMs >= 25) {
          // Serialize stalls block the daemon's single thread; surface them to attribute field typing stalls (issue #5096 family).
          recordDaemonStreamBacklogEvent('slowGetSnapshot', {
            sessionIdSuffix: request.payload.sessionId.slice(-10),
            snapshotMs: Math.round(snapshotMs)
          })
        }
        return { snapshot }
      }

      case 'getSize':
        return { size: this.host.getAppliedSize(request.payload.sessionId) }

      case 'takePendingOutput':
        // Why no await: with includeSnapshot, drain+serialize must share one sync turn or cold restore replays doubled PTY bytes.
        return this.host.takePendingOutput(
          request.payload.sessionId,
          request.payload.includeSnapshot === true,
          { teardownSnapshot: request.payload.teardownSnapshot === true }
        )

      case 'ping':
        return { pong: true }

      case 'systemResolverHealth':
        return { health: await readCurrentProcessMacSystemResolverHealth() }

      case 'ptySpawnHealth':
        await this.ptySpawnHealthCheck()
        return { healthy: true }

      case 'shutdown': {
        this.log.log('shutdown', {
          reason: 'rpc',
          killSessions: request.payload.killSessions === true
        })
        const serverClose = this.beginOrdinaryShutdownFence()
        if (request.payload.killSessions) {
          try {
            await this.host.dispose()
          } catch (err) {
            // Why: shutdown must always self-terminate; failed owners stay retryable for the follow-up shutdown() below.
            this.log.log('shutdown-dispose-failed', {
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
        const controlSocket = this.clients.get(clientId)?.controlSocket
        if (controlSocket) {
          this.deferShutdownUntilReply(clientId, request.id, controlSocket, () =>
            this.finishOrdinaryShutdown(serverClose)
          )
        } else if (!this.shutdownPromise) {
          this.shutdownPromise = this.finishOrdinaryShutdown(serverClose)
        }
        return {}
      }
    }
    throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
  }

  private sendExitEvent(
    client: ConnectedClient | undefined,
    sessionId: string,
    code: number
  ): void {
    if (!client?.streamSocket) {
      return
    }
    // Why: write/resize don't wait for replies, so this synthetic exit is the renderer's only signal to clear stale pane bindings.
    this.streamDataBatcher.enqueueControlEvent(client.clientId, sessionId, {
      type: 'event',
      event: 'exit',
      sessionId,
      payload: { code }
    })
    this.streamDataBatcher.flush(client.clientId)
  }
}
