// Wire-level handshake helpers for the Orca relay.
//
// Why this lives in its own module: oxlint enforces a 300-line limit (with
// blanks/comments stripped) on .ts files, and relay.ts already runs near that
// limit. Splitting the version-handshake plumbing into a sibling module keeps
// relay.ts focused on the daemon-lifecycle wiring and makes the handshake
// independently unit-testable.

import { dirname, join } from 'path'
import { existsSync, readFileSync, realpathSync } from 'fs'
import type { Socket } from 'net'
import {
  RELAY_VERSION,
  MessageType,
  FrameDecoder,
  encodeHandshakeFrame,
  parseHandshakeMessage,
  type DecodedFrame
} from './protocol'

// Why: a unique exit code reserved for the wire-level version-mismatch terminal
// condition. The client (waitForSentinel + ssh.ts) maps this exit code to a
// non-retryable RelayVersionMismatchError so _onRelayLost skips the backoff
// loop. Any other non-zero exit is treated as a transient transport error.
export const EXIT_CODE_VERSION_MISMATCH = 42

// Why: the deploy step writes a content-hashed version marker (e.g.
// "0.1.0+0a5fe134d020") into ${remoteDir}/.version next to relay.js. Read it
// from the directory the running script lives in (NOT process.cwd()) so test
// spawns from arbitrary working dirs still report a coherent version. We
// resolve symlinks via realpathSync so a daemon launched indirectly (e.g.
// `node /tmp/symlink-to-relay.js`) still finds .version next to the real
// script. Falls back to bare RELAY_VERSION only if the file truly cannot be
// read; the wire handshake then refuses a fresh content-hashed client and
// the user gets a clean typed error rather than a silent stale-daemon loop.
export function readLaunchVersion(): string {
  try {
    const entry = process.argv[1]
    let dir: string
    if (entry) {
      let resolved = entry
      try {
        resolved = realpathSync(entry)
      } catch {
        /* fall back to the unresolved path */
      }
      dir = dirname(resolved)
    } else {
      dir = process.cwd()
    }
    const versionFile = join(dir, '.version')
    if (existsSync(versionFile)) {
      const v = readFileSync(versionFile, 'utf-8').trim()
      if (v) {
        return v
      }
    }
  } catch {
    /* fall through */
  }
  return RELAY_VERSION
}

// ── Daemon side ─────────────────────────────────────────────────────

export type DaemonHandshakeCallbacks = {
  // Why: leftover is any bytes the FrameDecoder buffered AFTER the handshake
  // frame (e.g. the bridge wrote handshake + a JSON-RPC frame in the same
  // TCP send). The caller MUST feed leftover into the dispatcher before
  // attaching the new 'data' listener, otherwise those bytes are silently
  // lost.
  onAccepted: (sock: Socket, leftover: Buffer) => void
  launchVersion: string
}

// Why: pre-dispatcher version handshake. The daemon reads exactly one
// Handshake-typed frame off this freshly-accepted socket BEFORE the JSON-RPC
// dispatcher pipe is attached. Mismatch means the connecting bridge was
// launched against a different relay.js version than the daemon was; we close
// the socket so the bridge exits 42 and the client surfaces a typed error
// instead of looping over the dispatcher.
export function setupDaemonHandshake(sock: Socket, cb: DaemonHandshakeCallbacks): void {
  let handshakeResolved = false
  const decoder: FrameDecoder = new FrameDecoder(
    (frame: DecodedFrame) => {
      if (handshakeResolved) {
        return
      }
      const accepted = handleDaemonHandshakeFrame(sock, frame, cb.launchVersion)
      if (accepted) {
        handshakeResolved = true
        const leftover = decoder.drain()
        detachHandshakeListener(sock)
        cb.onAccepted(sock, leftover)
      }
    },
    (err) => {
      process.stderr.write(`[relay] Handshake decode error: ${err.message}\n`)
      sock.destroy()
    }
  )

  const onHandshakeData = (chunk: Buffer): void => {
    decoder.feed(chunk)
  }
  sock.on('data', onHandshakeData)
  ;(sock as Socket & { __orcaOnHandshake?: typeof onHandshakeData }).__orcaOnHandshake =
    onHandshakeData
}

export function detachHandshakeListener(sock: Socket): void {
  const tagged = sock as Socket & { __orcaOnHandshake?: (chunk: Buffer) => void }
  if (tagged.__orcaOnHandshake) {
    sock.removeListener('data', tagged.__orcaOnHandshake)
    delete tagged.__orcaOnHandshake
  }
}

function handleDaemonHandshakeFrame(
  sock: Socket,
  frame: DecodedFrame,
  launchVersion: string
): boolean {
  if (frame.type !== MessageType.Handshake) {
    process.stderr.write(
      `[relay] Protocol violation pre-handshake: type=${frame.type}; closing socket\n`
    )
    sock.destroy()
    return false
  }
  let msg: ReturnType<typeof parseHandshakeMessage>
  try {
    msg = parseHandshakeMessage(frame.payload)
  } catch (err) {
    process.stderr.write(
      `[relay] Could not parse handshake: ${(err as Error).message}; closing socket\n`
    )
    sock.destroy()
    return false
  }
  if (msg.type !== 'orca-relay-handshake') {
    process.stderr.write(
      `[relay] Unexpected handshake type from client: ${msg.type}; closing socket\n`
    )
    sock.destroy()
    return false
  }
  if (msg.version !== launchVersion) {
    process.stderr.write(
      `[relay] Handshake mismatch: own=${launchVersion}, client=${msg.version}; closing socket\n`
    )
    try {
      sock.write(
        encodeHandshakeFrame({
          type: 'orca-relay-handshake-mismatch',
          expected: launchVersion,
          got: msg.version
        })
      )
    } catch {
      /* best-effort — close+exit-42 still wins */
    }
    sock.end()
    return false
  }
  process.stderr.write(`[relay] Handshake OK from version=${msg.version}\n`)
  sock.write(encodeHandshakeFrame({ type: 'orca-relay-handshake-ok', version: launchVersion }))
  return true
}

// ── --connect side ──────────────────────────────────────────────────

export type ConnectHandshakeCallbacks = {
  // Why: leftover is any bytes the FrameDecoder buffered AFTER the
  // handshake-ok frame. The caller MUST forward leftover to process.stdout
  // (the SSH stdout pipe) before attaching the raw bridge, otherwise daemon
  // bytes coalesced into the same TCP send as handshake-ok are silently
  // dropped.
  onAccepted: (leftover: Buffer) => void
}

// Why: the wire-level version handshake from the bridge side. Before we attach
// the bidirectional pipe (and before we write RELAY_SENTINEL to stdout to
// unblock the client), we send a Handshake-typed frame carrying our version
// and wait for the daemon's Handshake response. This is defense-in-depth on
// top of the versioned-install-dir layout: a corrupt/missing .version, hash
// collision, or legacy-fallback path would otherwise let a v2 bridge drive a
// v1 daemon. VS Code's remoteExtensionHostAgentServer.ts:340 does the same
// check.
export function runConnectHandshake(
  sock: Socket,
  myVersion: string,
  cb: ConnectHandshakeCallbacks
): void {
  let handshakeDone = false

  const decoder: FrameDecoder = new FrameDecoder(
    (frame: DecodedFrame) => {
      if (handshakeDone) {
        return
      }
      if (frame.type !== MessageType.Handshake) {
        process.stderr.write(
          `[relay-connect] Protocol violation: expected Handshake frame, got type=${frame.type}\n`
        )
        sock.destroy()
        process.exit(1)
      }
      let msg: ReturnType<typeof parseHandshakeMessage>
      try {
        msg = parseHandshakeMessage(frame.payload)
      } catch (err) {
        process.stderr.write(
          `[relay-connect] Could not parse handshake reply: ${(err as Error).message}\n`
        )
        sock.destroy()
        process.exit(1)
      }
      if (msg.type === 'orca-relay-handshake-ok') {
        process.stderr.write(`[relay-connect] Handshake OK at version=${msg.version}\n`)
        handshakeDone = true
        const leftover = decoder.drain()
        sock.removeAllListeners('data')
        cb.onAccepted(leftover)
        return
      }
      if (msg.type === 'orca-relay-handshake-mismatch') {
        // Why: explicit stderr flush + exit so the diagnostic line is
        // delivered to the client BEFORE the process exits. Without this,
        // process.stderr writes can be buffered/async on pipe transports
        // and parseHandshakeMismatchStderr loses the version detail.
        process.stderr.write(
          `[relay-connect] Handshake mismatch: expected=${msg.expected}, daemon=${msg.got}; exiting ${EXIT_CODE_VERSION_MISMATCH}\n`,
          () => {
            sock.destroy()
            process.exit(EXIT_CODE_VERSION_MISMATCH)
          }
        )
        return
      }
      process.stderr.write(`[relay-connect] Unexpected handshake type: ${msg.type}\n`)
      sock.destroy()
      process.exit(1)
    },
    (err) => {
      process.stderr.write(`[relay-connect] Handshake decode error: ${err.message}\n`)
      sock.destroy()
      process.exit(1)
    }
  )

  sock.on('data', (chunk: Buffer) => {
    if (!handshakeDone) {
      decoder.feed(chunk)
    }
  })

  sock.write(encodeHandshakeFrame({ type: 'orca-relay-handshake', version: myVersion }))
}
