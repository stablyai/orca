#!/usr/bin/env node
/* oxlint-disable max-lines -- Why: the relay entry point centralizes process
   lifecycle (stdio, --connect bridge, grace timer, signal handlers, socket
   server) and handler registration in one file so the boot sequence stays in
   topological order. Splitting by line count would scatter ordered side-
   effects across modules and obscure the lifecycle. */

/* eslint-disable max-lines -- Why: the relay entrypoint owns process startup,
   daemon reconnect, and handler registration. Splitting the orchestration
   would hide the startup order, which is the important invariant here. */

// Orca Relay — lightweight daemon deployed to remote hosts.
// Communicates over stdin/stdout using the framed JSON-RPC protocol.
// The Electron app (client) deploys this script via SCP and launches
// it via an SSH exec channel.
//
// On client disconnect the relay enters a grace period, keeping PTYs
// alive and listening on a Unix domain socket. A subsequent app launch
// can reconnect by running relay.js --connect, which bridges the new
// SSH channel's stdin/stdout to the existing relay's socket.

import { createServer, createConnection, type Socket, type Server } from 'net'
import { homedir } from 'os'
import { resolve, join } from 'path'
import { unlinkSync, existsSync, statSync } from 'fs'
import {
  RELAY_SENTINEL,
  FrameDecoder,
  MessageType,
  encodeJsonRpcFrame,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcResponse
} from './protocol'
import { readLaunchVersion, runConnectHandshake, setupDaemonHandshake } from './relay-handshake'
import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { PtyHandler } from './pty-handler'
import { FsHandler } from './fs-handler'
import { GitHandler } from './git-handler'
import { PreflightHandler } from './preflight-handler'
import { ExternalAutomationsHandler } from './external-automations-handler'
import { PortScanHandler } from './port-scan-handler'
import { AgentExecHandler } from './agent-exec-handler'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import { endpointDirForRelaySocket, RelayAgentHookServer } from './agent-hook-server'
import { PluginOverlayManager, getRelayPiStatusExtensionPath } from './plugin-overlay'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../shared/ssh-types'
import { assertPluginSourceUnderByteCap } from './plugin-source-limit'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'
import { detectPiAgentKindFromCommand } from '../shared/pi-agent-kind'

const DEFAULT_GRACE_MS = DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
const SOCK_NAME = 'relay.sock'
const CONNECT_TIMEOUT_MS = 5_000
const STALE_SOCKET_PROBE_TIMEOUT_MS = 500
const EMPTY_DETACHED_STARTUP_GRACE_MS = parseNonNegativeIntEnv(
  'ORCA_RELAY_EMPTY_STARTUP_GRACE_MS',
  60_000
)

type SocketIdentity = {
  dev: bigint
  ino: bigint
  ctimeNs: bigint
}

function sameSocketIdentity(a: SocketIdentity, b: SocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function readSocketIdentity(sockPath: string): SocketIdentity | null {
  if (isWindowsNamedPipePath(sockPath)) {
    return null
  }
  try {
    const stat = statSync(sockPath, { bigint: true })
    return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs }
  } catch {
    return null
  }
}

function isWindowsNamedPipePath(sockPath: string): boolean {
  return process.platform === 'win32' && /^\\\\[.?]\\pipe\\/i.test(sockPath)
}

function parseArgs(argv: string[]): {
  graceTimeMs: number
  connectMode: boolean
  detached: boolean
  cliMode: boolean
  sockPath: string
  endpointDir?: string
} {
  let graceTimeMs = DEFAULT_GRACE_MS
  let connectMode = false
  let detached = false
  let cliMode = false
  let sockPath = ''
  let endpointDir: string | undefined
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--grace-time' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10)
      // Why: the CLI flag is in seconds for ergonomics, but internally we track
      // ms. 0 is allowed for opt-in synced workspaces that intentionally keep a
      // relay alive until explicitly terminated.
      if (!isNaN(parsed) && parsed >= 0) {
        graceTimeMs = parsed * 1000
      }
      i++
    } else if (argv[i] === '--connect') {
      connectMode = true
    } else if (argv[i] === '--orca-cli') {
      cliMode = true
    } else if (argv[i] === '--detached') {
      detached = true
    } else if (argv[i] === '--sock-path' && argv[i + 1]) {
      sockPath = argv[i + 1]
      i++
    } else if (argv[i] === '--endpoint-dir' && argv[i + 1]) {
      endpointDir = argv[i + 1]
      i++
    }
  }
  if (!sockPath) {
    sockPath = join(process.cwd(), SOCK_NAME)
  }
  return { graceTimeMs, connectMode, detached, cliMode, sockPath, endpointDir }
}

// ── Connect mode ─────────────────────────────────────────────────────
// Why: after an app restart, a new SSH exec channel is established but
// the original relay (with live PTYs) is still running in its grace
// period.  --connect bridges the new channel's stdin/stdout to the
// existing relay's Unix socket so the client talks to the SAME process
// that owns the PTY sessions.

function runConnectMode(sockPath: string): void {
  const myVersion = readLaunchVersion()
  const sock = createConnection({ path: sockPath })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[relay-connect] Connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(sock, myVersion, {
      onAccepted: (leftover: Buffer) => {
        // Why: RELAY_SENTINEL must be written AFTER the handshake passes; if it
        // were written earlier, waitForSentinel on the client would resolve
        // and start sending JSON-RPC over a socket the daemon was about to
        // close on mismatch — surfacing as a generic channel drop and
        // re-entering the backoff loop. Sequencing it post-handshake makes
        // mismatch a clean exit-42 path with no false-positive sentinel.
        process.stdout.write(RELAY_SENTINEL)
        // Why: bytes that arrived in the same TCP send as the handshake-ok
        // frame were buffered inside the handshake's FrameDecoder. Forward
        // them to stdout BEFORE attaching sock.pipe(process.stdout), so the
        // multiplexer downstream sees them in order and no daemon frames
        // are silently dropped at the transition.
        if (leftover.length > 0) {
          process.stdout.write(leftover)
        }
        process.stdin.pipe(sock)
        sock.pipe(process.stdout)
      }
    })
  })

  // Why: when the SSH channel closes, stdout becomes a broken pipe.
  // Node.js silently swallows EPIPE on process.stdout, so the bridge
  // stays alive as a zombie — connected to the relay socket but unable
  // to forward data. The relay keeps writing to this dead bridge,
  // silently dropping pty.data frames until the next --connect replaces
  // the socket. Exiting immediately on stdout error lets the relay
  // detect the disconnect (socket close) and enter grace mode promptly.
  process.stdout.on('error', () => {
    sock.destroy()
    process.exit(1)
  })

  sock.on('error', (err) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[relay-connect] Socket error: ${err.message}\n`)
    process.exit(1)
  })

  sock.on('close', () => {
    process.exit(0)
  })
}

function runOrcaCliMode(sockPath: string, argv: string[]): void {
  const myVersion = readLaunchVersion()
  const sock = createConnection({ path: sockPath })
  let nextSeq = 1
  let highestReceivedSeq = 0
  const requestId = 1

  const sendRequest = (): void => {
    const env = pickRemoteCliEnv(process.env)
    const frame = encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'orca.cli',
        params: {
          argv,
          cwd: process.cwd(),
          env
        }
      },
      nextSeq++,
      highestReceivedSeq
    )
    sock.write(frame)
  }

  const decoder = new FrameDecoder((frame: DecodedFrame) => {
    if (frame.id > highestReceivedSeq) {
      highestReceivedSeq = frame.id
    }
    if (frame.type !== MessageType.Regular) {
      return
    }
    const msg = parseJsonRpcMessage(frame.payload)
    if (!('id' in msg) || msg.id !== requestId || !('result' in msg || 'error' in msg)) {
      return
    }
    const response = msg as JsonRpcResponse
    if (response.error) {
      process.stderr.write(`${response.error.message}\n`)
      sock.destroy()
      process.exit(1)
    }
    const result = (response.result ?? {}) as {
      stdout?: unknown
      stderr?: unknown
      exitCode?: unknown
    }
    if (typeof result.stdout === 'string' && result.stdout.length > 0) {
      process.stdout.write(result.stdout)
    }
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      process.stderr.write(result.stderr)
    }
    sock.destroy()
    process.exit(typeof result.exitCode === 'number' ? result.exitCode : 0)
  })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[orca-cli] Relay connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(sock, myVersion, {
      onAccepted: (leftover) => {
        if (leftover.length > 0) {
          decoder.feed(leftover)
        }
        sock.on('data', (chunk) =>
          decoder.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        )
        sendRequest()
      }
    })
  })

  sock.on('error', (err) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[orca-cli] Relay socket error: ${err.message}\n`)
    process.exit(1)
  })
}

function pickRemoteCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of ['ORCA_TERMINAL_HANDLE', 'ORCA_USER_DATA_PATH', 'PATH', 'Path']) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}

// ── Normal mode ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { graceTimeMs, connectMode, detached, cliMode, sockPath, endpointDir } = parseArgs(
    process.argv
  )

  if (connectMode) {
    runConnectMode(sockPath)
    return
  }
  if (cliMode) {
    const marker = process.argv.indexOf('--orca-cli')
    runOrcaCliMode(sockPath, marker >= 0 ? process.argv.slice(marker + 1) : [])
    return
  }

  let ownsSocketPath = false
  let ownedSocketIdentity: SocketIdentity | null = null
  const ownsCurrentSocketPath = (): boolean => {
    if (isWindowsNamedPipePath(sockPath)) {
      return ownsSocketPath
    }
    const currentIdentity = readSocketIdentity(sockPath)
    return (
      ownsSocketPath &&
      ownedSocketIdentity !== null &&
      currentIdentity !== null &&
      sameSocketIdentity(currentIdentity, ownedSocketIdentity)
    )
  }
  const cleanupOwnedSocket = (): void => {
    if (ownsCurrentSocketPath()) {
      cleanupSocket(sockPath)
    }
    ownsSocketPath = false
    ownedSocketIdentity = null
  }

  // Why: After an uncaught exception Node's internal state may be corrupted
  // (e.g. half-written buffers, broken invariants). Logging and continuing
  // would risk silent data corruption or zombie PTYs. We log for diagnostics
  // and then exit so the client can detect the disconnect and reconnect cleanly.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[relay] Uncaught exception: ${err.message}\n${err.stack}\n`)
    cleanupOwnedSocket()
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[relay] Unhandled rejection: ${reason}\n`)
  })

  // Why: stdoutAlive tracks whether process.stdout is still writable.
  // After stdin ends (SSH channel dropped), the stdout pipe goes dead.
  // Without this guard, keepalive frames and pty.data notifications would
  // write to a dead pipe, silently failing or throwing EPIPE.  When a
  // socket client reconnects, setWrite swaps the callback to the socket.
  let stdoutAlive = true
  const dispatcher = new RelayDispatcher((data) => {
    if (stdoutAlive) {
      try {
        process.stdout.write(data)
      } catch {
        stdoutAlive = false
      }
    }
  })

  const context = new RelayContext()

  // Why: session.registerRoot is now a protocol-level no-op (the relay no
  // longer enforces a workspace allowlist; see docs/relay-fs-allowlist-removal.md).
  // Both notification and request handlers are retained so a new main
  // connecting to a new relay during the upgrade window — and an old main
  // connecting to a new relay — both keep working without "Method not found"
  // errors. Tracked for removal once the relay-version floor moves past the
  // cutover.
  dispatcher.onNotification('session.registerRoot', (params) => {
    const rootPath = params.rootPath as string
    if (rootPath) {
      context.registerRoot(rootPath)
    }
  })

  dispatcher.onRequest('session.registerRoot', async (params) => {
    const rootPath = params.rootPath as string
    if (rootPath) {
      context.registerRoot(rootPath)
    }
    return { ok: true }
  })

  // Why: the client stores repo paths as-is from user input, but `~` is a
  // shell expansion — Node's fs APIs don't understand it. This handler lets
  // the client resolve tilde paths to absolute paths on the remote host
  // before persisting them, so all downstream fs operations work correctly.
  dispatcher.onRequest('session.resolveHome', async (params) => {
    const inputPath = params.path as string
    if (inputPath === '~' || inputPath === '~/') {
      return { resolvedPath: homedir() }
    }
    if (inputPath.startsWith('~/')) {
      return { resolvedPath: resolve(homedir(), inputPath.slice(2)) }
    }
    return { resolvedPath: inputPath }
  })

  const ptyHandler = new PtyHandler(dispatcher, graceTimeMs)
  const fsHandler = new FsHandler(dispatcher, context)
  // Why: GitHandler registers its own request handlers on construction,
  // so we hold the reference only for potential future disposal.
  const _gitHandler = new GitHandler(dispatcher, context)
  void _gitHandler

  const _preflightHandler = new PreflightHandler(dispatcher)
  const _externalAutomationsHandler = new ExternalAutomationsHandler(dispatcher)
  void _preflightHandler
  void _externalAutomationsHandler

  const _portScanHandler = new PortScanHandler(dispatcher)
  void _portScanHandler

  const _agentExecHandler = new AgentExecHandler(dispatcher)
  void _agentExecHandler

  const _workspaceSessionHandler = new WorkspaceSessionHandler(dispatcher)
  void _workspaceSessionHandler

  dispatcher.onRequest('orca.cli', async (params, context) => {
    return await dispatcher.requestAnyClient('orca.cli', params, {
      excludeClientId: context.clientId
    })
  })

  function configureRelayGraceTime(params: Record<string, unknown>): { graceTimeMs: number } {
    const seconds = Number(params.graceTimeSeconds)
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Why: the host sends 0 before system sleep so live remote PTYs survive
      // longer than the ordinary disconnect grace window.
      ptyHandler.setGraceTimeMs(Math.floor(seconds) * 1000)
    }
    return { graceTimeMs: ptyHandler.configuredGraceTimeMs }
  }

  dispatcher.onNotification(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, (params) => {
    configureRelayGraceTime(params)
  })
  dispatcher.onRequest(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, async (params) =>
    configureRelayGraceTime(params)
  )

  // ── Agent-hook server ─────────────────────────────────────────────
  // Why: hosts a loopback HTTP receiver inside the relay process so agent
  // CLIs running in remote PTYs can post hook events without leaving the
  // host. Each parsed payload is forwarded to Orca via an `agent.hook`
  // JSON-RPC notification on the existing SSH channel — see
  // docs/design/agent-status-over-ssh.md §2-§5.
  const hookServer = new RelayAgentHookServer({
    // Why: a remote account can host multiple target-specific relay daemons.
    // Scope endpoint.env/cmd by the daemon socket path so their hook tokens
    // cannot overwrite each other.
    endpointDir: endpointDir ?? endpointDirForRelaySocket(sockPath),
    forward: (envelope) => {
      // Why: dispatcher.notify is fire-and-forget — when the SSH channel is
      // mid-reconnect the write callback no-ops and the notification is
      // silently dropped. The per-paneKey cache inside `hookServer` lets us
      // replay the last status for each live pane after Orca re-wires its
      // handler post-`--connect`.
      dispatcher.notify(
        AGENT_HOOK_NOTIFICATION_METHOD,
        envelope as unknown as Record<string, unknown>
      )
    }
  })
  // Why: await the hook-server bind before announcing readiness so the very
  // first PTY spawn (which can land within milliseconds of the sentinel)
  // already sees populated ORCA_AGENT_HOOK_* env. The bind is a local-loopback
  // listen — measured in ms — so the latency cost is trivial and removes a
  // class of "first agent invocation has no status" races. Bind failure is
  // treated as soft: log and continue, the augmenter returns {} and agent
  // status simply does not flow.
  try {
    await hookServer.start({ publishEndpoint: false })
  } catch (err) {
    process.stderr.write(
      `[relay] agent-hook server failed to start: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }

  // Why: every relay-spawned PTY needs the live ORCA_AGENT_HOOK_* coords. The
  // augmenter is read on every spawn so a hook-server bind that succeeded
  // late (or after a stop/start) lands in the next PTY's env without a
  // restart.
  ptyHandler.addEnvAugmenter(() => hookServer.buildPtyEnv())

  // Why: per-PTY plugin overlays for OpenCode and Pi. `OPENCODE_CONFIG_DIR`
  // and `PI_CODING_AGENT_DIR` only make sense on the relay's own filesystem
  // — paths the renderer would synthesize for the Orca host's userData are
  // meaningless on the remote. The overlay manager materializes a per-PTY
  // dir on the remote (rooted at $HOME/.orca-relay/) so the agent CLI inside
  // the relay-spawned PTY loads the bundled status plugin and posts to the
  // relay's hook server. Source bodies arrive over JSON-RPC (see
  // `agent_hook.installPlugins` below) — not bundled with the relay binary.
  const pluginOverlay = new PluginOverlayManager()
  ptyHandler.addEnvAugmenter((ctx) => {
    const env: Record<string, string> = {}
    // Why: prefer paneKey for overlay identity so a renderer-side remount
    // that reuses the paneKey lands in the same overlay dir. Falls back to
    // the relay-internal pty-id when paneKey is absent (e.g. CLI-launched
    // PTYs that don't go through the renderer).
    const overlayId = ctx.paneKey ?? ctx.id
    if (pluginOverlay.hasOpenCodeSource()) {
      const sourceDir = resolveOpenCodeSourceConfigDir(ctx.env, ctx.shell)
      const dir = pluginOverlay.materializeOpenCode(overlayId, sourceDir)
      if (dir) {
        env.OPENCODE_CONFIG_DIR = dir
        env.ORCA_OPENCODE_CONFIG_DIR = dir
        if (sourceDir) {
          env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = sourceDir
        }
      }
    }
    if (pluginOverlay.hasPiSource()) {
      // Why: source-dir defaulting is keyed on which Pi-compatible agent is
      // being launched (Pi vs OMP). The renderer-supplied `command` is the
      // only signal - disk-presence guessing silently shadows the other
      // agent's extensions when both `~/.pi/agent` and `~/.omp/agent` exist.
      const kind = detectPiAgentKindFromCommand(ctx.command)
      const hasLaunchCommand = typeof ctx.command === 'string' && ctx.command.trim().length > 0
      const shouldPrepareOmpShadow = kind === 'omp' || !hasLaunchCommand
      if (kind === 'pi') {
        const sourceDir = resolvePiSourceAgentDir(ctx.env, ctx.shell, 'pi')
        const dir = pluginOverlay.materializePi(overlayId, sourceDir, 'pi')
        if (dir) {
          env.PI_CODING_AGENT_DIR = dir
          // Why: shadow var is agent-scoped so remote shell-ready wrappers can
          // restore Pi by default while the `omp` wrapper switches on demand.
          env.ORCA_PI_CODING_AGENT_DIR = dir
          if (sourceDir) {
            env.ORCA_PI_SOURCE_AGENT_DIR = sourceDir
          }
        }
      }
      if (shouldPrepareOmpShadow) {
        // Why: in a bare shell, PI_CODING_AGENT_DIR is historically Pi's
        // default. Do not mirror it into OMP; use OMP's own default unless an
        // OMP-scoped source shadow is already present from a nested Orca shell.
        const sourceDir =
          kind === 'omp'
            ? resolvePiSourceAgentDir(ctx.env, ctx.shell, 'omp')
            : ctx.env.ORCA_OMP_SOURCE_AGENT_DIR
        const dir = pluginOverlay.materializePi(overlayId, sourceDir, 'omp')
        if (dir) {
          if (kind === 'omp') {
            env.PI_CODING_AGENT_DIR = dir
          }
          env.ORCA_OMP_CODING_AGENT_DIR = dir
          env.ORCA_OMP_STATUS_EXTENSION = getRelayPiStatusExtensionPath(dir)
          if (sourceDir) {
            env.ORCA_OMP_SOURCE_AGENT_DIR = sourceDir
          }
        }
      }
    }
    return env
  })

  // Why: evict the per-pane last-status cache AND any plugin overlay dirs
  // when the backing PTY exits so terminated panes do not (a) resurface as
  // ghost events after a later reconnect (§5 Path 3) or (b) leak overlay
  // dirs on a long-lived relay.
  ptyHandler.setExitListener(({ paneKey, id }) => {
    if (paneKey) {
      hookServer.clearPaneState(paneKey)
    }
    pluginOverlay.clearOverlay(paneKey ?? id)
  })

  // Why: request-driven replay. Orca issues this *after* it re-wires the
  // `agent.hook` filter on the new mux post-`--connect`. We forward each
  // cached entry as a fresh notification BEFORE returning so the response
  // strictly trails all replays on the dispatcher's single write callback —
  // closing the race the push-on-`setWrite` shape would have lost. See
  // docs/design/agent-status-over-ssh.md §5 Path 3.
  dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => {
    const replayed = hookServer.replayCachedPayloadsForPanes()
    return { replayed }
  })

  // Why: Orca ships the OpenCode plugin / Pi extension source bodies over
  // the wire at session-ready (the renderer's bundled hook-service strings
  // change as new agent events are added — pinning them to the relay binary
  // would force a relay redeploy on every Orca update). Cache them so each
  // subsequent PTY spawn can materialize a per-PTY overlay rooted under
  // $HOME/.orca-relay/. See docs/design/agent-status-over-ssh.md §4.
  // Why: bound the per-source size so a buggy/hostile Orca can't OOM the
  // relay by pushing a giant string. The HTTP path has HOOK_REQUEST_MAX_BYTES
  // = 1 MB; the JSON-RPC path needs an equivalent ceiling. Real plugin sources
  // are <50 KB today; 256 KB leaves generous headroom.
  dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => {
    const opencode = params.opencodePluginSource
    const pi = params.piExtensionSource
    const omp = params.ompExtensionSource
    assertPluginSourceUnderByteCap('opencodePluginSource', opencode)
    assertPluginSourceUnderByteCap('piExtensionSource', pi)
    assertPluginSourceUnderByteCap('ompExtensionSource', omp)
    pluginOverlay.setSources({
      opencodePluginSource: typeof opencode === 'string' ? opencode : undefined,
      piExtensionSource: typeof pi === 'string' ? pi : undefined,
      ompExtensionSource: typeof omp === 'string' ? omp : undefined
    })
    return {
      installed: {
        opencode: pluginOverlay.hasOpenCodeSource(),
        pi: pluginOverlay.hasPiSource('pi'),
        omp: pluginOverlay.hasPiSource('omp')
      }
    }
  })

  // ── Socket server for reconnection ──────────────────────────────────
  // Why: the relay's original stdin/stdout is tied to the SSH exec channel.
  // When the app restarts that channel is gone.  A Unix domain socket lets
  // a new --connect bridge pipe data to the same dispatcher that owns the
  // live PTYs — no serialization or process handoff needed.

  const socketClients = new Map<Socket, number>()
  let socketServer: Server | null = null
  const launchVersion = readLaunchVersion()
  const startedAt = Date.now()
  let acceptedSocketConnections = 0
  let hasAcceptedSocketClient = false
  let graceDeadlineAt: number | null = null
  let graceReason: string | null = null

  dispatcher.onRequest('relay.status', async () => ({
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    detached,
    stdoutAlive,
    memory: process.memoryUsage(),
    ptys: {
      active: ptyHandler.activePtyCount
    },
    socket: {
      path: sockPath,
      owned: ownsSocketPath,
      listening: socketServer?.listening ?? false,
      clients: socketClients.size,
      acceptedConnections: acceptedSocketConnections
    },
    grace: {
      active: ptyHandler.graceTimerActive,
      deadlineAt: graceDeadlineAt,
      reason: graceReason
    }
  }))

  function cancelGrace(reason: string): void {
    if (ptyHandler.graceTimerActive) {
      process.stderr.write(`[relay] Grace canceled: ${reason}\n`)
    }
    graceDeadlineAt = null
    graceReason = null
    ptyHandler.cancelGraceTimer()
  }

  function attachAcceptedSocket(sock: Socket, leftover: Buffer): void {
    // Why: stdin's data listener is still registered from the initial connection.
    // Pause/remove it once the first socket client is accepted so stale bytes
    // from the original SSH channel cannot interleave with socket frames.
    process.stdin.pause()
    process.stdin.removeAllListeners('data')

    hasAcceptedSocketClient = true
    acceptedSocketConnections++
    process.stderr.write(
      `[relay] Socket client accepted (clients=${socketClients.size + 1}, accepted=${acceptedSocketConnections})\n`
    )
    cancelGrace('socket client accepted')

    const clientId = dispatcher.attachClient((data) => {
      if (!sock.destroyed) {
        sock.write(data)
      }
    })
    socketClients.set(sock, clientId)

    // Why: bytes that arrived in the same TCP send as the handshake frame
    // were buffered inside the handshake's FrameDecoder. Feed them into the
    // dispatcher BEFORE wiring sock.on('data'), so frame ordering is
    // preserved and no client data is silently dropped at the transition.
    if (leftover.length > 0) {
      dispatcher.feedClient(clientId, leftover)
    }

    sock.on('data', (chunk: Buffer) => {
      cancelGrace('socket client data')
      dispatcher.feedClient(clientId, chunk)
    })
  }

  async function startSocketServer(): Promise<Server> {
    const server = createServer((sock) => {
      // Why: pre-dispatcher version handshake — see relay-handshake.ts.
      setupDaemonHandshake(sock, { launchVersion, onAccepted: attachAcceptedSocket })

      // Why: when --connect's SSH channel dies, stdin.pipe(sock) calls
      // sock.end(), sending FIN to the relay. Destroying on 'end' ensures
      // the 'close' handler fires promptly so the daemon can enter grace.
      sock.on('end', () => {
        if (!sock.destroyed) {
          sock.destroy()
        }
      })

      sock.on('error', () => {
        // Why: Node emits 'error' then 'close'. The close handler owns
        // activeSocket cleanup and grace startup.
      })

      sock.on('close', () => {
        const clientId = socketClients.get(sock)
        socketClients.delete(sock)
        if (clientId !== undefined) {
          dispatcher.detachClient(clientId)
        }
        process.stderr.write(`[relay] Socket client closed (clients=${socketClients.size})\n`)
        if (!stdoutAlive && socketClients.size === 0) {
          startGrace('socket client closed')
        }
      })
    })

    // Why: setting umask to 0o177 BEFORE listen ensures the socket is
    // created with 0o600 permissions atomically. The previous approach
    // (chmod after listen) had a TOCTOU window where another local user
    // could connect to the socket before chmod ran.
    const shouldSetSocketUmask = !isWindowsNamedPipePath(sockPath)
    const prevUmask = shouldSetSocketUmask ? process.umask(0o177) : 0
    let umaskRestored = false
    const restoreUmask = (): void => {
      if (shouldSetSocketUmask && !umaskRestored) {
        process.umask(prevUmask)
        umaskRestored = true
      }
    }

    await new Promise<void>((resolve, reject) => {
      let staleRetryAttempted = false

      function removeStartupListeners(): void {
        server.off('listening', onListening)
        server.off('error', onInitialError)
        server.off('error', failInitial)
      }

      function listenForStartupError(onError: (err: NodeJS.ErrnoException) => void): void {
        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(sockPath)
      }

      function onListening(): void {
        removeStartupListeners()
        restoreUmask()
        ownsSocketPath = true
        ownedSocketIdentity = readSocketIdentity(sockPath)
        server.on('error', (err) => {
          process.stderr.write(`[relay] Socket server error: ${err.message}\n`)
        })
        process.stderr.write(`[relay] Socket server listening: ${sockPath}\n`)
        resolve()
      }

      function failInitial(err: NodeJS.ErrnoException): void {
        removeStartupListeners()
        restoreUmask()
        if (err.code === 'EADDRINUSE') {
          process.stderr.write(
            `[relay] Socket path already in use: ${sockPath}; another relay is likely active. Use --connect instead of starting a new daemon.\n`
          )
        } else {
          process.stderr.write(`[relay] Socket server error before listen: ${err.message}\n`)
        }
        reject(err)
      }

      function unlinkIfStillStale(blockedIdentity: SocketIdentity | null): boolean {
        const currentIdentity = readSocketIdentity(sockPath)
        if (currentIdentity === null) {
          return true
        }
        if (blockedIdentity === null || !sameSocketIdentity(currentIdentity, blockedIdentity)) {
          return false
        }
        try {
          unlinkSync(sockPath)
          return true
        } catch (unlinkErr) {
          const e = unlinkErr as NodeJS.ErrnoException
          return e.code === 'ENOENT'
        }
      }

      // Why: a previous relay killed by SIGKILL/OOM/host-crash leaves the
      // socket file on disk with no listener. EADDRINUSE on bind in that
      // case is not "duplicate active" — it is a stale inode. Probe with a
      // short connect; if it refuses, the socket is dead and we may unlink
      // and retry once. If it connects, a live relay owns it and we keep
      // the existing "duplicate detected" rejection.
      function onInitialError(err: NodeJS.ErrnoException): void {
        if (err.code !== 'EADDRINUSE' || staleRetryAttempted) {
          failInitial(err)
          return
        }
        if (isWindowsNamedPipePath(sockPath)) {
          failInitial(err)
          return
        }
        staleRetryAttempted = true
        const blockedIdentity = readSocketIdentity(sockPath)
        const probe = createConnection({ path: sockPath })
        let probeSettled = false
        let probeTimeout: NodeJS.Timeout | null = null
        const finishProbe = (callback: () => void): void => {
          if (probeSettled) {
            return
          }
          probeSettled = true
          if (probeTimeout) {
            clearTimeout(probeTimeout)
          }
          callback()
        }
        probe.once('connect', () => {
          finishProbe(() => {
            probe.destroy()
            failInitial(err)
          })
        })
        probe.once('error', (probeErr: NodeJS.ErrnoException) => {
          finishProbe(() => {
            if (probeErr.code !== 'ECONNREFUSED' && probeErr.code !== 'ENOENT') {
              failInitial(err)
              return
            }
            if (!unlinkIfStillStale(blockedIdentity)) {
              failInitial(err)
              return
            }
            process.stderr.write(
              `[relay] Removed stale socket at ${sockPath} and retrying listen\n`
            )
            removeStartupListeners()
            listenForStartupError(failInitial)
          })
        })
        probeTimeout = setTimeout(() => {
          finishProbe(() => {
            probe.destroy()
            failInitial(err)
          })
        }, STALE_SOCKET_PROBE_TIMEOUT_MS)
      }

      listenForStartupError(onInitialError)
    })

    return server
  }

  try {
    socketServer = await startSocketServer()
    // Why: endpoint.env is shared by PTYs under this relay socket path. Publish
    // it only after socket ownership is proven so a refused duplicate daemon
    // cannot poison the active relay's hook coordinates.
    hookServer.publishEndpointFile()
  } catch {
    process.exit(1)
  }

  // ── stdin/stdout transport (initial connection) ─────────────────────

  // Why: when the SSH channel closes, writing to stdout can emit an
  // 'error' event (EPIPE/ERR_STREAM_DESTROYED). Without a handler,
  // Node treats it as an uncaught exception and the process exits
  // before the grace period starts.
  process.stdout.on('error', () => {
    stdoutAlive = false
    dispatcher.invalidateClient()
  })

  function startGrace(reason: string): void {
    const startupEmptyDetached =
      detached && !hasAcceptedSocketClient && ptyHandler.activePtyCount === 0
    const timeoutMs =
      graceTimeMs === 0
        ? 0
        : startupEmptyDetached
          ? Math.min(graceTimeMs, EMPTY_DETACHED_STARTUP_GRACE_MS)
          : graceTimeMs
    graceDeadlineAt = timeoutMs === 0 ? null : Date.now() + timeoutMs
    graceReason = reason
    process.stderr.write(
      `[relay] Grace started (${reason}): timeoutMs=${timeoutMs}, startupEmptyDetached=${startupEmptyDetached}, ptys=${ptyHandler.activePtyCount}, clients=${socketClients.size}\n`
    )
    ptyHandler.startGraceTimer(() => {
      process.stderr.write(`[relay] Grace expired (${reason}); shutting down\n`)
      shutdown()
    }, timeoutMs)
  }

  if (detached) {
    // Why: in detached mode the relay is backgrounded (nohup ... &) so
    // stdin is /dev/null and stdout goes to a log file.  Listening on
    // stdin would trigger an immediate EOF → grace → shutdown before any
    // --connect client arrives.  Instead we mark stdout dead (no direct
    // pipe), start the grace timer (socket connect will cancel it), and
    // rely entirely on the Unix socket for client communication.
    stdoutAlive = false
    startGrace('detached startup')
  } else {
    process.stdin.on('data', (chunk: Buffer) => {
      cancelGrace('stdin data')
      dispatcher.feed(chunk)
    })

    process.stdin.on('end', () => {
      // Why: stdout is piped to the SSH channel — once stdin closes the
      // channel is gone and stdout writes would hit a dead pipe.  Mark it
      // dead so the primary client write callback becomes a no-op while
      // socket clients, if any, keep their own live transports.
      stdoutAlive = false
      dispatcher.invalidateClient()
      if (socketClients.size === 0) {
        startGrace('stdin ended')
      }
    })

    process.stdin.on('error', () => {
      stdoutAlive = false
      dispatcher.invalidateClient()
      if (socketClients.size === 0) {
        startGrace('stdin error')
      }
    })
  }

  function shutdown(): void {
    process.stderr.write(
      `[relay] Shutdown: ptys=${ptyHandler.activePtyCount}, clients=${socketClients.size}, ownsSocket=${ownsSocketPath}\n`
    )
    graceDeadlineAt = null
    graceReason = null
    dispatcher.dispose()
    ptyHandler.dispose()
    fsHandler.dispose()
    hookServer.stop()
    // Why: Node's Unix server.close() can unlink the listen path. If the path
    // was externally removed and rebound by a newer relay, closing this older
    // server would strand the newer daemon behind a missing socket.
    if (socketServer && ownsCurrentSocketPath()) {
      socketServer.close()
    }
    cleanupOwnedSocket()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // Why: when the SSH session drops, the OS sends SIGHUP to the relay's
  // process group. Node's default SIGHUP behavior is to exit immediately,
  // which kills all PTYs before the grace period can start. Ignoring
  // SIGHUP lets the relay survive the SSH disconnect and enter its grace
  // window — a reconnecting client can then bridge to the live relay via
  // --connect and reattach to the still-running PTY sessions.
  process.on('SIGHUP', () => {
    process.stderr.write('[relay] Received SIGHUP (SSH session dropped), ignoring\n')
  })
  process.on('exit', (code) => {
    process.stderr.write(`[relay] Process exiting with code ${code}\n`)
  })

  // Signal readiness to the client — the client watches for this exact
  // string before sending framed data.
  process.stdout.write(RELAY_SENTINEL)
}

function cleanupSocket(sockPath: string): void {
  if (isWindowsNamedPipePath(sockPath)) {
    return
  }
  try {
    if (existsSync(sockPath)) {
      unlinkSync(sockPath)
    }
  } catch {
    /* best-effort */
  }
}

void main().catch((err) => {
  process.stderr.write(
    `[relay] Fatal startup error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})
