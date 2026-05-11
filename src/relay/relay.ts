#!/usr/bin/env node

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
import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { PtyHandler } from './pty-handler'
import { FsHandler } from './fs-handler'
import { GitHandler } from './git-handler'
import { PreflightHandler } from './preflight-handler'
import { PortScanHandler } from './port-scan-handler'

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
      // Why: the CLI flag is in seconds for ergonomics, but internally we track ms.
      if (!isNaN(parsed) && parsed > 0) {
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
  const sock = createConnection({ path: sockPath })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[relay-connect] Connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    // Why: the client-side waitForSentinel expects this exact string
    // before it starts sending framed data.  Emitting it here lets the
    // deploy code use the same sentinel-detection path for both fresh
    // launches and reconnects.
    process.stdout.write(RELAY_SENTINEL)
    process.stdin.pipe(sock)
    sock.pipe(process.stdout)
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

function main(): void {
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
  void _preflightHandler

  const _portScanHandler = new PortScanHandler(dispatcher)
  void _portScanHandler

  // ── Socket server for reconnection ──────────────────────────────────
  // Why: the relay's original stdin/stdout is tied to the SSH exec channel.
  // When the app restarts that channel is gone.  A Unix domain socket lets
  // a new --connect bridge pipe data to the same dispatcher that owns the
  // live PTYs — no serialization or process handoff needed.

  let activeSocket: Socket | null = null
  let socketServer: Server | null = null

  function startSocketServer(): Server {
    cleanupSocket(sockPath)
    const server = createServer((sock) => {
      // Why: only one client at a time.  If a second reconnect arrives
      // (e.g. user restarts again quickly), close the stale bridge so the
      // new one takes over cleanly.  We null activeSocket BEFORE destroying
      // so the old socket's close handler sees it's been replaced and
      // skips starting the grace timer.
      if (activeSocket) {
        process.stderr.write('[relay] Replacing existing socket client with new connection\n')
        const replaced = activeSocket
        activeSocket = null
        replaced.destroy()
      }
      activeSocket = sock

      // Why: stdin's data listener is still registered from the initial
      // connection. If the old SSH channel hasn't fully closed yet (TCP
      // FIN delayed), buffered stdin data would interleave with the new
      // socket client's frames, corrupting the frame decoder.
      process.stdin.pause()
      process.stdin.removeAllListeners('data')

      ptyHandler.cancelGraceTimer()

      dispatcher.setWrite((data) => {
        if (!sock.destroyed) {
          sock.write(data)
        }
      })

      sock.on('data', (chunk: Buffer) => {
        if (activeSocket !== sock) {
          return
        }
        ptyHandler.cancelGraceTimer()
        dispatcher.feed(chunk)
      })

      // Why: when the --connect bridge's SSH channel dies, stdin.pipe(sock)
      // calls sock.end(), sending FIN to the relay. Without this handler
      // the relay-side socket stays half-open — the relay keeps writing
      // pty.data frames that the bridge can no longer forward, silently
      // dropping output until the next --connect replaces the socket.
      // Destroying on 'end' ensures the 'close' handler fires promptly.
      sock.on('end', () => {
        if (!sock.destroyed) {
          sock.destroy()
        }
      })

      sock.on('close', () => {
        // Why: only start the grace timer if THIS socket is still the
        // active one.  If it was replaced by a newer connection (see
        // above), activeSocket was already nulled and reassigned — starting
        // the grace timer here would incorrectly begin shutdown while a
        // live client is connected.
        if (activeSocket === sock) {
          activeSocket = null
          dispatcher.invalidateClient()
          startGrace()
        }
      })

      sock.on('error', () => {
        // Why: Node emits 'error' then 'close'. The close handler owns
        // activeSocket cleanup and grace startup; clearing activeSocket here
        // would make close skip the grace timer and leave the relay alive
        // indefinitely with no client.
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
      // dead so the dispatcher's write callback becomes a no-op until a
      // socket client reconnects and calls setWrite with a live target.
      stdoutAlive = false
      if (!activeSocket) {
        dispatcher.invalidateClient()
        startGrace()
      }
    })

    process.stdin.on('error', () => {
      stdoutAlive = false
      if (!activeSocket) {
        dispatcher.invalidateClient()
        startGrace()
      }
    })
  }

  function shutdown(): void {
    dispatcher.dispose()
    ptyHandler.dispose()
    fsHandler.dispose()
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

main()
