#!/usr/bin/env node

// Orca Relay — lightweight daemon deployed to remote hosts.
// Communicates over stdin/stdout using the framed JSON-RPC protocol.
// The Electron app (client) deploys this script via SCP and launches
// it via an SSH exec channel.

import { RELAY_SENTINEL } from './protocol'
import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { PtyHandler } from './pty-handler'
import { FsHandler } from './fs-handler'
import { GitHandler } from './git-handler'
import { PreflightHandler } from './preflight-handler'

const DEFAULT_GRACE_MS = 5 * 60 * 1000

function parseArgs(argv: string[]): { graceTimeMs: number } {
  let graceTimeMs = DEFAULT_GRACE_MS
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--grace-time' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10)
      // Why: the CLI flag is in seconds for ergonomics, but internally we track ms.
      if (!isNaN(parsed) && parsed > 0) {
        graceTimeMs = parsed * 1000
      }
      i++
    }
  }
  return { graceTimeMs }
}

function main(): void {
  const { graceTimeMs } = parseArgs(process.argv)

  // Why: After an uncaught exception Node's internal state may be corrupted
  // (e.g. half-written buffers, broken invariants). Logging and continuing
  // would risk silent data corruption or zombie PTYs. We log for diagnostics
  // and then exit so the client can detect the disconnect and reconnect cleanly.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[relay] Uncaught exception: ${err.message}\n`)
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

  const ptyHandler = new PtyHandler(dispatcher, graceTimeMs)
  const fsHandler = new FsHandler(dispatcher, context)
  // Why: GitHandler registers its own request handlers on construction,
  // so we hold the reference only for potential future disposal.
  const _gitHandler = new GitHandler(dispatcher, context)
  void _gitHandler

  const _preflightHandler = new PreflightHandler(dispatcher)
  void _preflightHandler

  // Read framed binary data from stdin
  process.stdin.on('data', (chunk: Buffer) => {
    ptyHandler.cancelGraceTimer()
    dispatcher.feed(chunk)
  })

  process.stdin.on('end', () => {
    // Client disconnected — start grace timer to keep PTYs alive
    // for possible reconnection
    ptyHandler.startGraceTimer(() => {
      shutdown()
    })
  })

  process.stdin.on('error', () => {
    ptyHandler.startGraceTimer(() => {
      shutdown()
    })
  })

  function shutdown(): void {
    dispatcher.dispose()
    ptyHandler.dispose()
    fsHandler.dispose()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Signal readiness to the client — the client watches for this exact
  // string before sending framed data.
  process.stdout.write(RELAY_SENTINEL)
}

main()
