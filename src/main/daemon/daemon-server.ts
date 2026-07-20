/* eslint-disable max-lines -- Why: this class owns the daemon socket protocol,
   request routing, stream fanout, and session lifecycle in one place so
   renderer/daemon request semantics stay auditable across platform branches. */
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFileSync, chmodSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { encodeNdjson, createNdjsonParser } from './ndjson'
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
import { isNativeWindowsLocalPtySpawn } from '../runtime/terminal-model-query-authority'
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
}

type PendingPtySpawnPreparation = {
  canceled: boolean
}

type PendingShutdownReply = {
  start: () => void
}

export class DaemonServer {
  // Why: a new daemon must survive long enough for its first client pair, but
  // a parent crash between launch and adoption must not orphan it forever.
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
  private ptySpawnHealthCheck: () => Promise<void>
  private preparePtySpawn: () => Promise<void>
  private log: DaemonFileLog
  private transportSockets = new Set<Socket>()
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
  // Fact scan authority for backgrounded sessions — facts ride the stream
  // queue as control entries so they hold byte order with the data around
  // them (a fact jumping the queue could arrive after the reveal snapshot
  // that already reflects it).
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

  // Why: main-process PTY IPC has the same recent-input bypass, but daemon
  // output reaches main only after this stream layer. Keeping the window here
  // removes the daemon's fixed batch delay from keystroke echo/redraws while
  // preserving batching for background and large output.
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
    this.host = new TerminalHost({ spawnSubprocess: opts.spawnSubprocess })
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
        // Why: after bind, steady-state socket errors are handled per client;
        // the startup promise listener would otherwise retain this closure.
        this.server?.off('error', onListenError)
        writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
        try {
          chmodSync(this.socketPath, 0o600)
        } catch {
          // Best-effort on platforms that support it
        }
        if (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
          // Why: a parent crash before the first full client pair must not leave
          // a freshly published, empty daemon alive forever.
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
    // Why: close has already fenced this endpoint, but ownership checks still
    // prevent a late replacement's canonical token or PID record from removal.
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
      // Why: an unreapable child must not block daemon exit — after exit it
      // reparents to init, while a blocked daemon would orphan alongside it.
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
      // Why: call close synchronously before any awaited cleanup so no new
      // transport can enter after the idle fence is proven empty.
      server.close(() => {
        // Node owns unlinking its Unix listener. An extra check-then-unlink here could
        // delete a replacement endpoint installed concurrently after close.
        resolve()
      })
    })
  }

  private isIdle(): boolean {
    return (
      this.transportSockets.size === 0 &&
      this.clients.size === 0 &&
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
      // Why: work admitted before the fence wins. Clearing the pending state
      // keeps that already-started client/session fully usable.
      this.idleShutdownState = 'running'
      this.reevaluateIdleShutdown()
      return
    }

    this.idleShutdownState = 'shutting-down'
    // beginServerClose() runs synchronously up to server.close(), before host
    // disposal or file cleanup can yield to a racing connection.
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
    this.cancelInitialAdoptionTimer()
    this.transportSockets.add(socket)
    const removeTransport = (): void => {
      this.transportSockets.delete(socket)
      this.reevaluateIdleShutdown()
    }
    socket.once('close', removeTransport)
    socket.on('error', () => socket.destroy())

    if (this.idleShutdownState !== 'running') {
      // Why: an accepted connection queued just before server.close() must get
      // an explicit retry signal instead of appearing authenticated then dying.
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
    // Why: clients can send multibyte prompt/input text split across socket
    // chunks; keep UTF-8 sequences intact before NDJSON parsing.
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => this.handleFirstMessage(socket, msg, parser),
      () => {
        socket.destroy()
      }
    )

    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
  }

  private handleFirstMessage(
    socket: Socket,
    msg: unknown,
    _parser: ReturnType<typeof createNdjsonParser>
  ): void {
    const hello = msg as HelloMessage
    if (hello.type !== 'hello') {
      this.log.log('client-hello-rejected', { reason: 'expected-hello' })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }

    if (hello.version !== this.protocolVersion) {
      this.log.log('client-hello-rejected', {
        reason: 'protocol-mismatch',
        clientVersion: hello.version
      })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Protocol version mismatch' }))
      socket.destroy()
      return
    }

    if (hello.token !== this.token) {
      this.log.log('client-hello-rejected', { reason: 'invalid-token', role: hello.role })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }))
      socket.destroy()
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
      const previous = this.clients.get(hello.clientId)
      const client: ConnectedClient = {
        clientId: hello.clientId,
        controlSocket: socket,
        streamSocket: null,
        authenticatedPairEstablished: false
      }
      this.clients.set(hello.clientId, client)
      this.setupControlSocket(socket, hello.clientId)
      if (previous) {
        this.recordFullyAuthenticatedDisconnect(previous.authenticatedPairEstablished)
        // Why: a reconnect can reuse a clientId before the old sockets notice
        // their close. Tear them down after installing the new owner so stale
        // close events cannot delete the replacement client entry.
        previous.streamSocket?.destroy()
        previous.controlSocket.destroy()
      }
    } else if (hello.role === 'stream') {
      const client = this.clients.get(hello.clientId)
      if (!client) {
        // Why: stream sockets are only meaningful beside a control socket; an
        // orphan stream would otherwise stay open with no tracked owner.
        socket.destroy()
        return
      }
      this.setupStreamSocket(socket, client)
      client.authenticatedPairEstablished = true
      // A complete app connection, unlike a health or raw socket probe, owns
      // the endpoint again and cancels pending event-driven retirement.
      this.initialAdoptionDeadlineMs = null
      this.retirementRequested = false
      this.cancelInitialAdoptionTimer()
    }
  }

  private setupControlSocket(socket: Socket, clientId: string): void {
    // Why: terminal writes and startup commands can contain emoji/Unicode.
    // Decoding per Buffer would corrupt split multibyte sequences.
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => this.handleRequest(socket, clientId, msg as DaemonRequest),
      () => {} // Ignore parse errors
    )

    // Remove the initial data listener and replace with the RPC parser
    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))

    socket.on('close', () => {
      const client = this.clients.get(clientId)
      if (client?.controlSocket !== socket) {
        return
      }
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
    // Why: once the last full client is gone, exact daemon-side emptiness is
    // sufficient; incomplete transports may block but never erase this request.
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
      this.streamDataBatcher.clear(client.clientId)
      client.streamSocket = null
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)

    if (previous && previous !== socket) {
      // Why: replacing a stream socket must not leave the old receive-only
      // channel alive and untracked.
      previous.destroy()
    }
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
        socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }), () => {
          pendingShutdown?.start()
        })
      }
    } catch (err) {
      if (!isNotify) {
        socket.write(
          encodeNdjson({
            id: request.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        )
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
    // Why: a non-reading authenticated peer must not pin a fenced daemon by
    // holding its acknowledgement behind permanent socket backpressure.
    timer = setTimeout(start, DaemonServer.SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS)
    timer.unref()
    socket.once('close', start)
    socket.once('error', start)
    this.pendingShutdownReplies.set(key, { start })
  }

  private async preparePtySpawnUnlessCanceled(sessionId: string): Promise<void> {
    const preparation: PendingPtySpawnPreparation = { canceled: false }
    const pending = this.pendingPtySpawnPreparations.get(sessionId) ?? new Set()
    pending.add(preparation)
    this.pendingPtySpawnPreparations.set(sessionId, pending)
    try {
      // Why: registration precedes the async capability probe so a concurrent
      // close can cancel this exact creation before a subprocess exists.
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

  private async routeRequest(clientId: string, request: DaemonRequest): Promise<unknown> {
    const client = this.clients.get(clientId)

    switch (request.type) {
      case 'createOrAttach': {
        if (this.idleShutdownState !== 'running') {
          throw new Error('Daemon temporarily unavailable; reconnect')
        }
        if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
          // Why: a control-only replacement cannot own terminal admission or
          // erase the prior full client's monotonic retirement request.
          throw new Error('Daemon client connection is incomplete; reconnect')
        }
        this.createOrAttachInFlight++
        const p = request.payload
        let result: Awaited<ReturnType<TerminalHost['createOrAttach']>>
        try {
          await this.preparePtySpawnUnlessCanceled(p.sessionId)
          result = await this.host.createOrAttach({
            sessionId: p.sessionId,
            cols: p.cols,
            rows: p.rows,
            cwd: p.cwd,
            env: p.env,
            envToDelete: p.envToDelete,
            command: p.command,
            startupCommandDelivery: p.startupCommandDelivery,
            // Why: daemon RPC payloads are untrusted JSON. Persist only the
            // allowlisted enum used for byte routing, never arbitrary identity.
            ...(isTuiAgent(p.launchAgent) ? { launchAgent: p.launchAgent } : {}),
            shellOverride: p.shellOverride,
            terminalWindowsWslDistro: p.terminalWindowsWslDistro,
            terminalWindowsPowerShellImplementation: p.terminalWindowsPowerShellImplementation,
            shellReadySupported: p.shellReadySupported,
            historySeed: p.historySeed,
            startupIngress: parsePtyStartupIngressIntent(p.startupIngress, {
              allowWindowsEchoProjection: isNativeWindowsLocalPtySpawn({
                connectionId: null,
                cwd: p.cwd,
                shellOverride: p.shellOverride
              })
            }),
            ...(p.shellReadyTimeoutMs !== undefined
              ? { shellReadyTimeoutMs: p.shellReadyTimeoutMs }
              : {}),
            streamClient: {
              onData: (data, rawLength = data.length, transformed = false, seq) => {
                // Scan BEFORE enqueue: the batcher may keep-tail drop this
                // chunk, but its facts must be captured regardless.
                this.transientFactRelay.onSessionData(p.sessionId, data)
                const lastInputAt = this.lastInputAtBySessionId.get(p.sessionId)
                const isInteractiveOutput =
                  data.length <= DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS &&
                  lastInputAt !== undefined &&
                  performance.now() - lastInputAt <= DaemonServer.INTERACTIVE_OUTPUT_WINDOW_MS
                this.streamDataBatcher.enqueue(clientId, p.sessionId, data, {
                  flushImmediately: isInteractiveOutput,
                  flushMaxChars: DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS,
                  rawLength,
                  transformed,
                  seq
                })
              },
              onExit: (code) => {
                // Why: exit tears down renderer handlers, so it must ride the
                // ordered queue behind final output even when the shallow socket
                // gate holds that output for a later drain pass.
                this.log.log('session-exited', { sessionId: p.sessionId, code })
                this.streamDataBatcher.enqueueControlEvent(clientId, p.sessionId, {
                  type: 'event',
                  event: 'exit',
                  sessionId: p.sessionId,
                  payload: { code }
                })
                this.streamDataBatcher.flush(clientId)
                recordDaemonStreamBacklogEvent('sessionExit', {
                  sessionIdSuffix: p.sessionId.slice(-10)
                })
                this.transientFactRelay.onSessionExit(p.sessionId)
                this.streamClientIdBySessionId.delete(p.sessionId)
                this.lastInputAtBySessionId.delete(p.sessionId)
                this.reevaluateIdleShutdown()
              }
            }
          })
        } finally {
          this.createOrAttachInFlight--
          this.reevaluateIdleShutdown()
        }
        this.streamClientIdBySessionId.set(p.sessionId, clientId)
        // Why an attach-time marker: the adapter resyncs the background set on
        // a fresh connection, which can precede this attach — main's scan
        // suppression must still start at the head of the new stream.
        if (this.transientFactRelay.isBackgrounded(p.sessionId)) {
          this.streamDataBatcher.enqueueControlEvent(clientId, p.sessionId, {
            type: 'event',
            event: 'sessionBackgroundMarker',
            sessionId: p.sessionId,
            payload: { background: true }
          })
        }
        this.log.log(result.isNew ? 'session-created' : 'session-attached', {
          sessionId: p.sessionId,
          pid: result.pid
        })
        return {
          isNew: result.isNew,
          snapshot: result.snapshot,
          pid: result.pid,
          shellState: result.shellState,
          ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
          wslDistro: result.wslDistro,
          ...(result.historySeeded !== undefined ? { historySeeded: result.historySeeded } : {})
        }
      }

      case 'cancelCreateOrAttach':
        this.cancelPendingPtySpawnPreparations(request.payload.sessionId)
        return {}

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
          // Prime the fresh relay tracker with the emulator's dangling
          // incomplete escape so a sequence split across the handoff parses
          // exactly as if the relay had seen the whole stream.
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
        // Reveal deliberately does NOT discard or force-flush the queued
        // tail: main's model (hidden-output recovery buffer, tail previews)
        // needs those bytes — a finished program's last output lives there —
        // and the normal flush/drain loop delivers them within milliseconds
        // (bounded ≤ the keep-tail drop cap), in order, ahead of the marker.
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
          // Why: a kill that wins before session registration has already
          // canceled the pending spawn and therefore completed its intent.
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
        // Note: detach token handling is simplified here — full implementation
        // would track tokens per client
        this.log.log('session-detached', { sessionId: request.payload.sessionId })
        return {}

      case 'getCwd':
        return { cwd: await this.host.getCwd(request.payload.sessionId) }

      case 'getForegroundProcess':
        return { foregroundProcess: this.host.getForegroundProcess(request.payload.sessionId) }

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
        // Why: close before acknowledging retirement so no new terminal can
        // race between the empty proof and daemon disposal.
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
          // Serialize stalls block the daemon's single thread — every pty's
          // echo included. Surfaced here so multi-second typing stalls can be
          // attributed to checkpoint storms (issue #5096 family) in the field.
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
        // Why no await before this call: with includeSnapshot, drain and
        // serialize must share one synchronous turn — an intervening await
        // would let PTY data land in between, and cold restore would replay
        // those bytes on top of a snapshot that already contains them.
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
            // Why: the shutdown RPC contract is that the daemon always
            // self-terminates; dispose keeps failed owners retryable, and the
            // follow-up shutdown() below retries them once more before exit.
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
    // Why: write/resize are notification-heavy and intentionally do not wait
    // for replies. If their target session is gone, this synthetic exit is the
    // only signal the renderer gets to clear stale terminal pane bindings.
    this.streamDataBatcher.enqueueControlEvent(client.clientId, sessionId, {
      type: 'event',
      event: 'exit',
      sessionId,
      payload: { code }
    })
    this.streamDataBatcher.flush(client.clientId)
  }
}
