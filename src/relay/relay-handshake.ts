// Wire-level handshake helpers for the Orca relay.

import { dirname, join } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { Socket } from 'node:net'
import {
  RELAY_VERSION,
  MessageType,
  FrameDecoder,
  encodeHandshakeFrame,
  parseHandshakeMessage,
  type DecodedFrame
} from './protocol'
import { relayLogLine } from './relay-diagnostic-log'

// Why: client maps this exit code to a non-retryable error so it skips reconnect backoff; other non-zero exits are treated as transient.
export const EXIT_CODE_VERSION_MISMATCH = 42

// Why: read .version next to the resolved script path (realpathSync, not cwd) so arbitrary-cwd or symlink-launched spawns still report a coherent version.
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
  // leftover: bytes buffered after the handshake frame; caller must feed the dispatcher before attaching the data listener or they're lost.
  onAccepted: (sock: Socket, leftover: Buffer) => void
  launchVersion: string
}

// Why: read one handshake frame before attaching the dispatcher; version mismatch closes the socket so the bridge exits 42.
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
    relayLogLine(`[relay] Could not parse handshake: ${(err as Error).message}; closing socket`)
    sock.destroy()
    return false
  }
  if (msg.type !== 'orca-relay-handshake') {
    relayLogLine(`[relay] Unexpected handshake type from client: ${msg.type}; closing socket`)
    sock.destroy()
    return false
  }
  if (msg.version !== launchVersion) {
    relayLogLine(
      `[relay] Handshake mismatch: own=${launchVersion}, client=${msg.version}; closing socket`
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
  // leftover: bytes buffered after handshake-ok; caller must forward to stdout before attaching the bridge or they're dropped.
  onAccepted: (leftover: Buffer) => void
}

// Why: bridge-side version handshake; defense-in-depth so a bad .version can't let a v2 bridge drive a v1 daemon (cf. VS Code remoteExtensionHostAgentServer.ts:340).
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
        // Why: exit inside the write callback; stderr is async on pipe transports, so exiting early drops the version detail.
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
