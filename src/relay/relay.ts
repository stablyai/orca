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

const DEFAULT_GRACE_MS = 5 * 60 * 1000
const SOCK_NAME = 'relay.sock'

function parseArgs(argv: string[]): {
  graceTimeMs: number
  connectMode: boolean
  sockPath: string
} {
  let graceTimeMs = DEFAULT_GRACE_MS
  let connectMode = false
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
    } else if (argv[i] === '--sock-path' && argv[i + 1]) {
      sockPath = argv[i + 1]
      i++
    }
  }
  if (!sockPath) {
    sockPath = join(process.cwd(), SOCK_NAME)
  }
  return { graceTimeMs, connectMode, sockPath }
}

// ── Connect mode ─────────────────────────────────────────────────────
// Why: after an app restart, a new SSH exec channel is established but
// the original relay (with live PTYs) is still running in its grace
// period.  --connect bridges the new channel's stdin/stdout to the
// existing relay's Unix socket so the client talks to the SAME process
// that owns the PTY sessions.

function runConnectMode(sockPath: string): void {
  const sock = createConnection({ path: sockPath })

  sock.on('connect', () => {
    // Why: the client-side waitForSentinel expects this exact string
    // before it starts sending framed data.  Emitting it here lets the
    // deploy code use the same sentinel-detection path for both fresh
    // launches and reconnects.
    process.stdout.write(RELAY_SENTINEL)
    process.stdin.pipe(sock)
    sock.pipe(process.stdout)
  })

  sock.on('error', (err) => {
    process.stderr.write(`[relay-connect] Socket error: ${err.message}\n`)
    process.exit(1)
  })

  sock.on('close', () => {
    process.exit(0)
  })

  process.stdin.on('end', () => {
    sock.end()
  })
}

// ── Normal mode ──────────────────────────────────────────────────────

function main(): void {
  const { graceTimeMs, connectMode, sockPath } = parseArgs(process.argv)

  if (connectMode) {
    runConnectMode(sockPath)
    return
  }

  // Why: After an uncaught exception Node's internal state may be corrupted
  // (e.g. half-written buffers, broken invariants). Logging and continuing
  // would risk silent data corruption or zombie PTYs. We log for diagnostics
  // and then exit so the client can detect the disconnect and reconnect cleanly.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[relay] Uncaught exception: ${err.message}\n`)
    cleanupSocket(sockPath)
    process.exit(1)
  })

  const dispatcher = new RelayDispatcher((data) => {
    process.stdout.write(data)
  })

  const context = new RelayContext()

  dispatcher.onNotification('session.registerRoot', (params) => {
    const rootPath = params.rootPath as string
    if (rootPath) {
      context.registerRoot(rootPath)
    }
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
      // new one takes over cleanly.
      if (activeSocket) {
        activeSocket.destroy()
      }
      activeSocket = sock

      ptyHandler.cancelGraceTimer()

      dispatcher.setWrite((data) => {
        if (!sock.destroyed) {
          sock.write(data)
        }
      })

      sock.on('data', (chunk: Buffer) => {
        ptyHandler.cancelGraceTimer()
        dispatcher.feed(chunk)
      })

      sock.on('close', () => {
        if (activeSocket === sock) {
          activeSocket = null
        }
        startGrace()
      })

      sock.on('error', () => {
        if (activeSocket === sock) {
          activeSocket = null
        }
        startGrace()
      })
    })

    server.on('error', (err) => {
      process.stderr.write(`[relay] Socket server error: ${err.message}\n`)
    })

    server.listen(sockPath)
    return server
  }

  socketServer = startSocketServer()

  // ── stdin/stdout transport (initial connection) ─────────────────────

  process.stdin.on('data', (chunk: Buffer) => {
    ptyHandler.cancelGraceTimer()
    dispatcher.feed(chunk)
  })

  process.stdin.on('end', () => {
    // Why: stdin closed means the SSH channel dropped.  Switch dispatcher
    // output to the socket (if one is connected) or start the grace timer.
    // The socket server stays up so a reconnect bridge can attach.
    if (!activeSocket) {
      startGrace()
    }
  })

  process.stdin.on('error', () => {
    if (!activeSocket) {
      startGrace()
    }
  })

  function startGrace(): void {
    ptyHandler.startGraceTimer(() => {
      shutdown()
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
