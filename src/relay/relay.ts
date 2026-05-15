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
import { unlinkSync, existsSync } from 'fs'
import { RELAY_SENTINEL } from './protocol'
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
import { PluginOverlayManager } from './plugin-overlay'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import { assertPluginSourceUnderByteCap } from './plugin-source-limit'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'

const DEFAULT_GRACE_MS = 5 * 60 * 1000
const SOCK_NAME = 'relay.sock'
const CONNECT_TIMEOUT_MS = 5_000

function parseArgs(argv: string[]): {
  graceTimeMs: number
  connectMode: boolean
  detached: boolean
  sockPath: string
} {
  let graceTimeMs = DEFAULT_GRACE_MS
  let connectMode = false
  let detached = false
  let sockPath = ''
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
    } else if (argv[i] === '--detached') {
      detached = true
    } else if (argv[i] === '--sock-path' && argv[i + 1]) {
      sockPath = argv[i + 1]
      i++
    }
  }
  if (!sockPath) {
    sockPath = join(process.cwd(), SOCK_NAME)
  }
  return { graceTimeMs, connectMode, detached, sockPath }
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

// ── Normal mode ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { graceTimeMs, connectMode, detached, sockPath } = parseArgs(process.argv)

  if (connectMode) {
    runConnectMode(sockPath)
    return
  }

  // Why: After an uncaught exception Node's internal state may be corrupted
  // (e.g. half-written buffers, broken invariants). Logging and continuing
  // would risk silent data corruption or zombie PTYs. We log for diagnostics
  // and then exit so the client can detect the disconnect and reconnect cleanly.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[relay] Uncaught exception: ${err.message}\n${err.stack}\n`)
    cleanupSocket(sockPath)
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
    endpointDir: endpointDirForRelaySocket(sockPath),
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
    await hookServer.start()
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
      const sourceDir = resolvePiSourceAgentDir(ctx.env, ctx.shell)
      const dir = pluginOverlay.materializePi(overlayId, sourceDir)
      if (dir) {
        env.PI_CODING_AGENT_DIR = dir
        env.ORCA_PI_CODING_AGENT_DIR = dir
        if (sourceDir) {
          env.ORCA_PI_SOURCE_AGENT_DIR = sourceDir
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
    assertPluginSourceUnderByteCap('opencodePluginSource', opencode)
    assertPluginSourceUnderByteCap('piExtensionSource', pi)
    pluginOverlay.setSources({
      opencodePluginSource: typeof opencode === 'string' ? opencode : undefined,
      piExtensionSource: typeof pi === 'string' ? pi : undefined
    })
    return {
      installed: {
        opencode: pluginOverlay.hasOpenCodeSource(),
        pi: pluginOverlay.hasPiSource()
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

  function attachAcceptedSocket(sock: Socket, leftover: Buffer): void {
    // Why: stdin's data listener is still registered from the initial connection.
    // Pause/remove it once the first socket client is accepted so stale bytes
    // from the original SSH channel cannot interleave with socket frames.
    process.stdin.pause()
    process.stdin.removeAllListeners('data')

    ptyHandler.cancelGraceTimer()

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
      ptyHandler.cancelGraceTimer()
      dispatcher.feedClient(clientId, chunk)
    })
  }

  function startSocketServer(): Server {
    cleanupSocket(sockPath)
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
        if (!stdoutAlive && socketClients.size === 0) {
          startGrace()
        }
      })
    })

    // Why: setting umask to 0o177 BEFORE listen ensures the socket is
    // created with 0o600 permissions atomically. The previous approach
    // (chmod after listen) had a TOCTOU window where another local user
    // could connect to the socket before chmod ran.
    const prevUmask = process.umask(0o177)

    server.on('error', (err) => {
      process.umask(prevUmask)
      process.stderr.write(`[relay] Socket server error: ${err.message}\n`)
    })

    server.listen(sockPath, () => {
      process.umask(prevUmask)
    })
    return server
  }

  socketServer = startSocketServer()

  // ── stdin/stdout transport (initial connection) ─────────────────────

  // Why: when the SSH channel closes, writing to stdout can emit an
  // 'error' event (EPIPE/ERR_STREAM_DESTROYED). Without a handler,
  // Node treats it as an uncaught exception and the process exits
  // before the grace period starts.
  process.stdout.on('error', () => {
    stdoutAlive = false
    dispatcher.invalidateClient()
  })

  function startGrace(): void {
    ptyHandler.startGraceTimer(() => {
      shutdown()
    })
  }

  if (detached) {
    // Why: in detached mode the relay is backgrounded (nohup ... &) so
    // stdin is /dev/null and stdout goes to a log file.  Listening on
    // stdin would trigger an immediate EOF → grace → shutdown before any
    // --connect client arrives.  Instead we mark stdout dead (no direct
    // pipe), start the grace timer (socket connect will cancel it), and
    // rely entirely on the Unix socket for client communication.
    stdoutAlive = false
    startGrace()
  } else {
    process.stdin.on('data', (chunk: Buffer) => {
      ptyHandler.cancelGraceTimer()
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
        startGrace()
      }
    })

    process.stdin.on('error', () => {
      stdoutAlive = false
      dispatcher.invalidateClient()
      if (socketClients.size === 0) {
        startGrace()
      }
    })
  }

  function shutdown(): void {
    dispatcher.dispose()
    ptyHandler.dispose()
    fsHandler.dispose()
    hookServer.stop()
    if (socketServer) {
      socketServer.close()
    }
    cleanupSocket(sockPath)
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
