/* eslint-disable max-lines -- Why: this file is the single security boundary for the bundled CLI — transport setup, auth-token enforcement, admission control, keepalive framing, and orphan-socket sweeping all co-locate deliberately so a reviewer can audit the boundary in one sitting. Splitting this across files would scatter the invariants without reducing complexity. */
// Why: this is the single security boundary for the bundled CLI. It owns
// auth-token enforcement, bootstrap-metadata publication, and transport
// orchestration so a running runtime is always discoverable via exactly
// one on-disk file. Method handling lives in `rpc/` and transport specifics
// live in `rpc/unix-socket-transport.ts` and `rpc/ws-transport.ts`.
import { randomBytes } from 'crypto'
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from './orca-runtime'
import { writeRuntimeMetadata } from './runtime-metadata'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { errorResponse } from './rpc/errors'
import type { RpcMessageContext, RpcTransport } from './rpc/transport'
import { UnixSocketTransport } from './rpc/unix-socket-transport'
import { WebSocketTransport } from './rpc/ws-transport'
import type { WebSocket } from 'ws'
import { DeviceRegistry, type DeviceScope } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import { E2EEChannel } from './rpc/e2ee-channel'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import {
  decodeTerminalStreamFrame,
  type TerminalStreamFrame
} from '../../shared/terminal-stream-protocol'

const DEFAULT_WS_PORT = 6768

type OrcaRuntimeRpcServerOptions = {
  runtime: OrcaRuntimeService
  userDataPath: string
  pid?: number
  platform?: NodeJS.Platform
  enableWebSocket?: boolean
  wsPort?: number
  webClientRoot?: string
  // Why: test-only overrides for the two time-bound constants below.
  // Production callers must not pass these — defaults are set by the design
  // doc (§3.1) and changing them in production would weaken the admission
  // fence or flood the socket with keepalive frames.
  keepaliveIntervalMs?: number
  longPollCap?: number
}

// Why: after 10 s of a pending dispatch we emit a tiny `{"_keepalive":true}`
// frame every 10 s until the handler resolves. Each write resets both the
// server's own socket idle timer (30 s) and — once §3.1 ships on the client —
// the client's idle timer, because any byte counts as socket activity. This
// is the transport-layer fix for feedback #1: long-poll RPCs (i.e.
// orchestration.check --wait) can now run past the 30 s/60 s idle caps
// without either end tearing the socket down. See design doc §3.1.
const KEEPALIVE_INTERVAL_MS = 10_000

// Why: long-poll slot cap. With keepalives a `check --wait --timeout-ms
// 600000` can hold a connection for up to 10 minutes; unbounded that would
// saturate MAX_RUNTIME_RPC_CONNECTIONS (32) with 32 waiting coordinators
// and lock out normal short RPCs. Capping at half the connection budget
// leaves the other half for short traffic. On overflow the server responds
// immediately with `runtime_busy` (CLI exit 75) — fail fast, not silent
// queuing. See design doc §3.1 + §7 risk #2.
const LONG_POLL_CAP = 16

function resolvePairingEndpoint(rawEndpoint: string, address: string | null | undefined): string {
  const endpoint = new URL(rawEndpoint)
  const override = address?.trim()
  if (!override) {
    endpoint.hostname = '127.0.0.1'
    return formatWebSocketUrl(endpoint)
  }
  if (/^wss?:\/\//i.test(override)) {
    return formatWebSocketUrl(new URL(override))
  }
  const parsed = parsePairingAddressOverride(override)
  endpoint.hostname = parsed.host.includes(':')
    ? `[${parsed.host.replace(/^\[|\]$/g, '')}]`
    : parsed.host
  if (parsed.port) {
    endpoint.port = parsed.port
  }
  return formatWebSocketUrl(endpoint)
}

function parsePairingAddressOverride(address: string): { host: string; port: string | null } {
  if (address.startsWith('[') || address.split(':').length === 2) {
    try {
      const parsed = new URL(`ws://${address}`)
      return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port: parsed.port || null }
    } catch {
      return { host: address, port: null }
    }
  }
  return { host: address, port: null }
}

function formatWebSocketUrl(url: URL): string {
  const formatted = url.toString()
  return url.pathname === '/' && !url.search && !url.hash ? formatted.replace(/\/$/, '') : formatted
}

function createWebClientUrl(endpoint: string, pairingUrl: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = webClientPathForEndpoint(url.pathname)
  url.search = ''
  // Why: pairing URLs include full runtime credentials. Keeping them in the
  // fragment avoids proxy logs and Referer headers while the web app loads.
  url.hash = `pairing=${encodeURIComponent(pairingUrl)}`
  return url.toString()
}

function webClientPathForEndpoint(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/web-index.html'
  }
  return `${pathname.replace(/\/$/, '')}/web-index.html`
}

const MOBILE_RPC_METHOD_ALLOWLIST = new Set([
  'accounts.list',
  'accounts.selectClaude',
  'accounts.selectCodex',
  'accounts.subscribe',
  'accounts.unsubscribe',
  'files.list',
  'files.open',
  'files.read',
  'markdown.readTab',
  'markdown.saveTab',
  'notifications.subscribe',
  'notifications.unsubscribe',
  'repo.hooks',
  'repo.list',
  'session.tabs.activate',
  'session.tabs.close',
  'session.tabs.createTerminal',
  'session.tabs.list',
  'session.tabs.subscribe',
  'session.tabs.unsubscribe',
  'stats.summary',
  'status.get',
  'terminal.clearBuffer',
  'terminal.close',
  'terminal.create',
  'terminal.focus',
  'terminal.getAutoRestoreFit',
  'terminal.list',
  'terminal.multiplex',
  'terminal.read',
  'terminal.rename',
  'terminal.send',
  'terminal.setAutoRestoreFit',
  'terminal.setDisplayMode',
  'terminal.subscribe',
  'terminal.unsubscribe',
  'terminal.updateViewport',
  'worktree.activate',
  'worktree.create',
  'worktree.ps',
  'worktree.rm',
  'worktree.set',
  'worktree.sleep'
])

// Why: a long-poll request is one whose handler blocks waiting for an external
// event. This function is the single place that classifies it — the long-poll
// counter, abort wiring, keepalives, and runtime_busy admission check all
// share this decision. See §3.1.
function isLongPollRequest(request: RpcRequest): boolean {
  if (request.method === 'terminal.wait') {
    return true
  }
  if (request.method === 'orchestration.check') {
    const params = request.params as { wait?: unknown } | undefined
    return params?.wait === true
  }
  return false
}

export class OrcaRuntimeRpcServer {
  private readonly runtime: OrcaRuntimeService
  private readonly dispatcher: RpcDispatcher
  private readonly userDataPath: string
  private readonly pid: number
  private readonly platform: NodeJS.Platform
  private readonly enableWebSocket: boolean
  private readonly wsPort: number
  private readonly webClientRoot: string | undefined
  private readonly authToken = randomBytes(24).toString('hex')
  private readonly keepaliveIntervalMs: number
  private readonly longPollCap: number
  private deviceRegistry: DeviceRegistry | null = null
  private e2eeKeypair: E2EEKeypair | null = null
  private tlsFingerprint: string | null = null
  private wsTransport: WebSocketTransport | null = null
  private activeTransports: RpcTransport[] = []
  private transports: RuntimeTransportMetadata[] = []
  // Why: each WebSocket connection has its own E2EE channel that manages the
  // handshake and encrypt/decrypt lifecycle. Keyed by WebSocket instance.
  private e2eeChannels = new Map<WebSocket, E2EEChannel>()
  // Why: stable per-WebSocket id used as the cleanup key for streaming
  // subscriptions, so the server can reap a closing socket's subscriptions
  // without affecting other live sockets that share the same deviceToken.
  private wsConnectionIds = new Map<WebSocket, string>()
  private readonly binaryStreamHandlers = new Map<
    string,
    Map<number, (frame: TerminalStreamFrame) => void>
  >()
  // Why: separate from Node's server.maxConnections because we need to count
  // only long-running dispatches, not every in-flight short RPC. See §3.1 +
  // §7 risk #2.
  private activeLongPolls = 0

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform,
    enableWebSocket = false,
    wsPort = DEFAULT_WS_PORT,
    webClientRoot,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    longPollCap = LONG_POLL_CAP
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    this.dispatcher = new RpcDispatcher({ runtime })
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
    this.enableWebSocket = enableWebSocket
    this.wsPort = wsPort
    this.webClientRoot = webClientRoot
    this.keepaliveIntervalMs = keepaliveIntervalMs
    this.longPollCap = longPollCap
  }

  getDeviceRegistry(): DeviceRegistry | null {
    return this.deviceRegistry
  }

  getTlsFingerprint(): string | null {
    return this.tlsFingerprint
  }

  getE2EEPublicKey(): string | null {
    return this.e2eeKeypair?.publicKeyB64 ?? null
  }

  getE2EEKeypair(): E2EEKeypair | null {
    return this.e2eeKeypair
  }

  revokeMobileDevice(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'mobile' || !this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.wsTransport?.terminateClientConnections(device.token)
    return true
  }

  getWebSocketEndpoint(): string | null {
    const ws = this.transports.find((t) => t.kind === 'websocket')
    return ws?.endpoint ?? null
  }

  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: DeviceScope
  }):
    | { available: false }
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        webClientUrl: string | null
      } {
    const rawEndpoint = this.getWebSocketEndpoint()
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!rawEndpoint || !this.deviceRegistry || !publicKeyB64) {
      return { available: false }
    }

    const endpoint = resolvePairingEndpoint(rawEndpoint, args.address)
    const deviceName = args.name ?? `CLI ${new Date().toLocaleDateString()}`
    const scope = args.scope ?? 'runtime'
    const device = args.rotate
      ? this.deviceRegistry.rotatePendingDevice(deviceName, scope)
      : this.deviceRegistry.getOrCreatePendingDevice(deviceName, scope)
    const pairingUrl = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      publicKeyB64
    })
    return {
      available: true,
      pairingUrl,
      endpoint,
      deviceId: device.deviceId,
      webClientUrl:
        this.webClientRoot && scope === 'runtime' ? createWebClientUrl(endpoint, pairingUrl) : null
    }
  }

  private registerBinaryStreamHandler(
    connectionId: string | undefined,
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ): () => void {
    if (!connectionId || !Number.isInteger(streamId) || streamId < 0) {
      return () => {}
    }
    let handlers = this.binaryStreamHandlers.get(connectionId)
    if (!handlers) {
      handlers = new Map()
      this.binaryStreamHandlers.set(connectionId, handlers)
    }
    handlers.set(streamId, handler)
    return () => {
      const current = this.binaryStreamHandlers.get(connectionId)
      if (!current || current.get(streamId) !== handler) {
        return
      }
      current.delete(streamId)
      if (current.size === 0) {
        this.binaryStreamHandlers.delete(connectionId)
      }
    }
  }

  private handleWebSocketBinaryMessage(bytes: Uint8Array<ArrayBufferLike>, ws: WebSocket): void {
    const connectionId = this.wsConnectionIds.get(ws)
    if (!connectionId) {
      return
    }
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    this.binaryStreamHandlers.get(connectionId)?.get(frame.streamId)?.(frame)
  }

  async start(): Promise<void> {
    if (this.activeTransports.length > 0) {
      return
    }

    // Why: processes killed by SIGKILL / OOM-kill / forced-shutdown skip
    // stop() and leave behind `o-<pid>-*.sock` files in userData. Sweeping
    // dead-pid sockets at startup keeps the directory from accumulating
    // orphans over the app's lifetime. Named-pipe transports on Windows do
    // not leave filesystem entries in userData, so the sweep is a no-op
    // there.
    if (this.platform !== 'win32') {
      sweepOrphanedRuntimeSockets(this.userDataPath, this.pid)
    }

    const transportMeta = createRuntimeTransportMetadata(
      this.userDataPath,
      this.pid,
      this.platform,
      this.runtime.getRuntimeId()
    )

    const socketTransport = new UnixSocketTransport({
      endpoint: transportMeta.endpoint,
      kind: transportMeta.kind as 'unix' | 'named-pipe',
      keepaliveIntervalMs: this.keepaliveIntervalMs
    })

    // Why: Unix socket transport uses the shared runtime auth token. This is
    // the existing security model for CLI connections — the token lives in a
    // 0o600-permissioned file on disk.
    // Why: the `.catch` guarantees `reply()` always fires even if
    // `handleMessage` (or `JSON.stringify` on a pathological response) throws.
    // Without it, a throw would leave the client waiting for a terminal frame
    // that never arrives AND leak the dispatch's AbortController in the
    // transport's in-flight set until the 30 s socket idle timer closes the
    // connection.
    socketTransport.onMessage((msg, reply, context) => {
      void this.handleMessage(msg, context)
        .then((response) => {
          reply(JSON.stringify(response))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          // Why: best-effort id recovery so the client can correlate the
          // error frame to its pending request. A malformed message would
          // have been caught by handleMessage and returned an envelope
          // instead of throwing, so in practice the id is always present.
          let id = 'unknown'
          try {
            const parsed = JSON.parse(msg) as { id?: unknown }
            if (typeof parsed.id === 'string' && parsed.id.length > 0) {
              id = parsed.id
            }
          } catch {
            // ignore — fall through with id='unknown'
          }
          reply(JSON.stringify(this.buildError(id, 'internal_error', message)))
        })
    })

    await socketTransport.start()

    const activeTransports: RpcTransport[] = [socketTransport]
    const transportsMeta: RuntimeTransportMetadata[] = [transportMeta]

    // Why: WebSocket transport is opt-in and starts alongside the Unix socket.
    // It uses per-device tokens and E2EE (application-layer encryption via
    // tweetnacl) rather than TLS, since React Native can't pin self-signed certs.
    if (this.enableWebSocket) {
      try {
        this.deviceRegistry = new DeviceRegistry(this.userDataPath)
        this.e2eeKeypair = loadOrCreateE2EEKeypair(this.userDataPath)

        const wsTransport = new WebSocketTransport({
          host: '0.0.0.0',
          port: this.wsPort,
          staticRoot: this.webClientRoot
        })
        this.wsTransport = wsTransport

        // Why: each WebSocket connection gets an E2EE channel that handles the
        // handshake before any RPC messages are processed. The channel decrypts
        // inbound messages and encrypts outbound replies transparently.
        wsTransport.onMessage((msg, _reply, ws) => {
          let channel = this.e2eeChannels.get(ws)
          if (!channel) {
            // Why: stable per-ws id used as the cleanup-index key for
            // streaming subscriptions, so the server can reap them exactly
            // when this socket closes (without affecting other live sockets
            // that share the same deviceToken).
            this.wsConnectionIds.set(ws, randomBytes(8).toString('hex'))
            channel = new E2EEChannel(ws, {
              serverSecretKey: this.e2eeKeypair!.secretKey,
              validateToken: (token) => this.deviceRegistry?.validateToken(token) != null,
              onReady: (ch) => {
                if (ch.deviceToken) {
                  wsTransport.setClientId(ws, ch.deviceToken)
                  // Why: mark the device as actually connected so it appears
                  // in the "Paired Devices" list. Devices that were only
                  // generated as QR codes but never scanned stay hidden.
                  const device = this.deviceRegistry?.validateToken(ch.deviceToken)
                  if (device) {
                    this.deviceRegistry?.updateLastSeen(device.deviceId)
                  }
                }
              },
              onError: (code, reason) => {
                this.e2eeChannels.get(ws)?.destroy()
                this.e2eeChannels.delete(ws)
                ws.close(code, reason)
              }
            })
            channel.onMessage((plaintext, encryptedReply, encryptedBinaryReply) => {
              void this.handleWebSocketMessage(
                plaintext,
                encryptedReply,
                encryptedBinaryReply,
                wsTransport,
                ws
              )
            })
            channel.onBinaryMessage((bytes) => this.handleWebSocketBinaryMessage(bytes, ws))
            this.e2eeChannels.set(ws, channel)
          }
          channel.handleRawMessage(msg)
        })

        // Why: when a mobile client disconnects, the runtime must clean up
        // connection-scoped state like mobile-fit overrides and the E2EE
        // channel to prevent orphaned state. A single paired device can hold
        // multiple concurrent sockets (host screen + accounts screen, etc.),
        // so destroy the channel for THIS exact ws and skip the per-client
        // teardown when other sockets for the same token are still alive.
        wsTransport.onConnectionClose((clientId, ws, hasOtherConnections) => {
          // Why: sweep streaming subscriptions for THIS ws regardless of
          // hasOtherConnections, so per-ws listeners (notifications,
          // accounts, terminal) don't leak across reconnects. This is
          // independent of the deviceToken-scoped onClientDisconnected.
          const connectionId = this.wsConnectionIds.get(ws)
          if (connectionId) {
            this.runtime.cleanupSubscriptionsForConnection(connectionId)
            this.runtime.cancelMobileDictationForConnection(connectionId)
            this.binaryStreamHandlers.delete(connectionId)
            this.wsConnectionIds.delete(ws)
          }
          const channel = this.e2eeChannels.get(ws)
          if (channel) {
            channel.destroy()
            this.e2eeChannels.delete(ws)
          }
          if (clientId && !hasOtherConnections) {
            this.runtime.onClientDisconnected(clientId)
          }
        })

        await wsTransport.start()
        activeTransports.push(wsTransport)
        transportsMeta.push({
          kind: 'websocket',
          endpoint: `ws://0.0.0.0:${wsTransport.resolvedPort}`
        })
      } catch (error) {
        // Why: WebSocket transport is supplementary — the runtime must still
        // function if it fails to start (e.g., port in use). Log and continue
        // with Unix socket only.
        console.error('[runtime] Failed to start WebSocket transport:', error)
        this.wsTransport = null
      }
    }

    // Why: publish the transport into in-memory state before writing metadata
    // so the bootstrap file always contains the real endpoint/token pair. The
    // CLI only discovers the runtime through that file.
    this.activeTransports = activeTransports
    this.transports = transportsMeta

    try {
      this.writeMetadata()
    } catch (error) {
      // Why: a runtime that cannot publish bootstrap metadata is invisible to
      // the `orca` CLI. Close all transports immediately instead of leaving
      // behind a live but undiscoverable control plane.
      this.activeTransports = []
      this.transports = []
      await Promise.all(activeTransports.map((t) => t.stop().catch(() => {}))).catch(() => {})
      throw error
    }
  }

  async stop(): Promise<void> {
    const transports = this.activeTransports
    this.activeTransports = []
    this.transports = []
    this.wsTransport = null
    if (transports.length === 0) {
      return
    }
    await Promise.all(transports.map((t) => t.stop()))
    // Why: we intentionally leave the last metadata file behind instead of
    // deleting it on shutdown. Shared userData paths can briefly host multiple
    // Orca processes during restarts, updates, or development, and stale
    // metadata is safer than letting one process erase another live runtime's
    // bootstrap file.
  }

  // Why: Unix socket messages use one-shot dispatch (single response per
  // request) and the shared runtime auth token from the 0o600 metadata file.
  // The transport layer owns socket lifecycle, keepalive writes, and the
  // per-connection abort signal — this method just parses, auths, and
  // dispatches. See design doc §3.1.
  private async handleMessage(
    rawMessage: string,
    context?: RpcMessageContext
  ): Promise<RpcResponse> {
    // Why: empty messages are sent by the Unix socket transport layer when a
    // client exceeds the max message size. The transport closes the connection
    // after this response.
    if (!rawMessage) {
      return this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size')
    }

    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      return parsed.error
    }
    const request = parsed.request

    // Why: long-poll admission fence. Short RPCs bypass the counter entirely
    // — it only guards handlers that can block for minutes. See §7 risk #2.
    const longPoll = isLongPollRequest(request)
    if (longPoll && this.activeLongPolls >= this.longPollCap) {
      return this.buildError(
        request.id,
        'runtime_busy',
        'long-poll capacity reached; retry with backoff'
      )
    }
    if (longPoll) {
      this.activeLongPolls += 1
      // Why: arm the keepalive timer only for long-polls. Short RPCs never
      // touch it so the `setInterval` is never created. See §3.1.
      context?.startKeepalive()
    }

    try {
      return await this.dispatcher.dispatch(request, {
        signal: longPoll ? context?.signal : undefined
      })
    } finally {
      if (longPoll) {
        this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
      }
    }
  }

  private parseAndAuth(rawMessage: string): { request: RpcRequest } | { error: RpcResponse } {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return { error: this.buildError('unknown', 'bad_request', 'Invalid JSON request') }
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return { error: this.buildError('unknown', 'bad_request', 'Missing request id') }
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return { error: this.buildError(request.id, 'bad_request', 'Missing RPC method') }
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return { error: this.buildError(request.id, 'unauthorized', 'Missing auth token') }
    }
    if (request.authToken !== this.authToken) {
      return { error: this.buildError(request.id, 'unauthorized', 'Invalid auth token') }
    }

    return { request }
  }

  // Why: WebSocket messages go through streaming dispatch which can emit
  // multiple responses. Auth uses per-device tokens from the device registry.
  private async handleWebSocketMessage(
    rawMessage: string,
    reply: (response: string) => void,
    sendBinary: (response: Uint8Array<ArrayBufferLike>) => void,
    wsTransport?: WebSocketTransport,
    ws?: WebSocket
  ): Promise<void> {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request')))
      return
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Missing request id')))
      return
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      reply(JSON.stringify(this.buildError(request.id, 'bad_request', 'Missing RPC method')))
      return
    }

    const token =
      typeof (request as Record<string, unknown>).deviceToken === 'string'
        ? ((request as Record<string, unknown>).deviceToken as string)
        : null
    if (!token) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Missing device token')))
      return
    }
    const device = this.deviceRegistry?.validateToken(token)
    if (!device) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device token')))
      return
    }
    if (device.scope === 'mobile' && !MOBILE_RPC_METHOD_ALLOWLIST.has(request.method)) {
      reply(
        JSON.stringify(
          this.buildError(
            request.id,
            'forbidden',
            `Method '${request.method}' is not available to mobile clients`
          )
        )
      )
      return
    }

    // Why: associate the deviceToken with this WebSocket so ws.on('close')
    // can notify the runtime which mobile client disconnected.
    if (wsTransport && ws) {
      wsTransport.setClientId(ws, token)
    }

    const longPoll = isLongPollRequest(request)
    if (longPoll && this.activeLongPolls >= this.longPollCap) {
      reply(
        JSON.stringify(
          this.buildError(
            request.id,
            'runtime_busy',
            'long-poll capacity reached; retry with backoff'
          )
        )
      )
      return
    }

    let abortController: AbortController | null = null
    let abortOnClose: (() => void) | null = null
    if (longPoll) {
      this.activeLongPolls += 1
      abortController = new AbortController()
      if (ws) {
        abortOnClose = () => abortController?.abort()
        ws.once('close', abortOnClose)
        ws.once('error', abortOnClose)
        if (ws.readyState !== ws.OPEN) {
          abortController.abort()
        }
      }
    }

    const connectionId = ws ? this.wsConnectionIds.get(ws) : undefined
    try {
      await this.dispatcher.dispatchStreaming(request, reply, {
        connectionId,
        clientId: token,
        signal: abortController?.signal,
        sendBinary,
        registerBinaryStreamHandler: (streamId, handler) =>
          this.registerBinaryStreamHandler(connectionId, streamId, handler)
      })
    } finally {
      if (abortOnClose && ws) {
        ws.off('close', abortOnClose)
        ws.off('error', abortOnClose)
      }
      if (longPoll) {
        this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
      }
    }
  }

  private buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  private writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transports: this.transports,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}

/**
 * Why: the regex MUST stay in lockstep with createRuntimeTransportMetadata()
 * below, which emits `o-${pid}-${endpointSuffix}.sock` where endpointSuffix
 * is `[A-Za-z0-9_-]{1,4}` (derived from a sanitised runtimeId prefix, or
 * `'rt'` as the fallback). The invariant is covered by a unit test so any
 * future change to the transport-name shape trips CI.
 */
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

export function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
  } catch {
    // Why: first-launch userData may not exist yet; the cold-start path
    // below will create it. Nothing to sweep in that case.
    return
  }
  for (const entry of entries) {
    const match = RUNTIME_SOCKET_NAME_REGEX.exec(entry)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isFinite(pid)) {
      continue
    }
    // Why: never touch the current process's socket. start() already
    // rmSync's it if it exists, but belt-and-braces — a bug in the own-pid
    // path here would rmSync a socket we're about to bind to.
    if (pid === ownPid) {
      continue
    }
    try {
      // Why: signal 0 is the POSIX liveness probe — it delivers no signal
      // but returns success iff the pid resolves AND the caller has
      // permission to signal it. ESRCH = no such process; EPERM = pid
      // exists but owned by another user, which is extremely unusual on a
      // desktop app's userData dir but we conservatively leave those
      // sockets alone.
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(userDataPath, entry), { force: true })
        } catch {
          // Why: best-effort sweep — a permission error on unlink is fine
          // to ignore; the socket will be cleaned by a later start() or
          // by the OS on reboot.
        }
      }
    }
  }
}

export function createRuntimeTransportMetadata(
  userDataPath: string,
  pid: number,
  platform: NodeJS.Platform,
  runtimeId = 'runtime'
): RuntimeTransportMetadata {
  const endpointSuffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      // Why: Windows named pipes do not get the same chmod hardening path as
      // Unix sockets, so include a per-runtime suffix to avoid exposing a
      // stable, guessable control endpoint name across launches.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
