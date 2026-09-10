// Wire-level handshake helpers for the Orca relay.

import { dirname, join } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { Socket } from 'node:net'
import {
  RELAY_VERSION,
  RELAY_PROTOCOL_VERSION,
  MessageType,
  FrameDecoder,
  encodeHandshakeFrame,
  parseHandshakeMessage,
  relayProtocolOffer,
  relayProtocolOfferAdmits,
  type DecodedFrame,
  type RelayHandshakeCapabilities
} from './protocol'
import { PTY_CONSUMER_SESSION_PROTOCOL_VERSION } from '../shared/pty-consumer-session-contract'
import { relayLogLine } from './relay-diagnostic-log'

// Contracts that turn over independently of the handshake integer, so a client cannot infer them
// from `protocolVersion` and must not have to infer them from the build hash either.
function relayHandshakeCapabilities(): RelayHandshakeCapabilities {
  return { ptyConsumerSession: PTY_CONSUMER_SESSION_PROTOCOL_VERSION }
}

// Why: clients treat this exit code as non-retryable; other non-zero exits are transient.
export const EXIT_CODE_VERSION_MISMATCH = 42
// Why distinct from 42: a refused credential is a live daemon saying no, which the client must
// not confuse with a crashed bridge (exit 0/1) or with a version skew (42).
export const EXIT_CODE_CREDENTIAL_MISMATCH = 43

// Why: read .version beside the resolved script path, not the arbitrary launch cwd.
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
  endpointCredential?: string
}

// Why: read one handshake frame before attaching the dispatcher; version mismatch closes the socket so the bridge exits 42.
export function setupDaemonHandshake(sock: Socket, cb: DaemonHandshakeCallbacks): void {
  let handshakeResolved = false
  const decoder: FrameDecoder = new FrameDecoder(
    (frame: DecodedFrame) => {
      if (handshakeResolved) {
        return
      }
      const accepted = handleDaemonHandshakeFrame(sock, frame, cb)
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
  cb: DaemonHandshakeCallbacks
): boolean {
  const { launchVersion, endpointCredential } = cb
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
  // Why the build hash is still first: it is the only gate every already-deployed relay has, and
  // it stays the fallback for peers that offer no protocol range at all. Negotiation is what lets
  // a relay stranded by an app update keep serving the PTYs it already owns (#13852) — the hash
  // differs by construction there, while the wire is unchanged.
  const negotiated = msg.version === launchVersion || relayProtocolOfferAdmits(msg)
  if (!negotiated) {
    relayLogLine(
      `[relay] Handshake mismatch: own=${launchVersion}/p${RELAY_PROTOCOL_VERSION}, ` +
        `client=${msg.version}/p${msg.protocolVersion ?? 'none'}; closing socket`
    )
    try {
      sock.write(
        encodeHandshakeFrame({
          type: 'orca-relay-handshake-mismatch',
          expected: launchVersion,
          got: msg.version,
          ...relayProtocolOffer()
        })
      )
    } catch {
      /* best-effort — close+exit-42 still wins */
    }
    sock.end()
    return false
  }
  const presented = 'endpointCredential' in msg ? msg.endpointCredential : undefined
  if (endpointCredential !== undefined && presented !== endpointCredential) {
    relayLogLine('[relay] Endpoint credential mismatch; closing socket')
    try {
      sock.write(encodeHandshakeFrame({ type: 'orca-relay-handshake-credential-mismatch' }))
    } catch {
      /* best-effort — the close alone still refuses */
    }
    sock.end()
    return false
  }
  process.stderr.write(
    `[relay] Handshake OK from version=${msg.version} (${msg.version === launchVersion ? 'same build' : `cross-build, protocol ${RELAY_PROTOCOL_VERSION}`})\n`
  )
  sock.write(
    encodeHandshakeFrame({
      type: 'orca-relay-handshake-ok',
      version: launchVersion,
      ...relayProtocolOffer(),
      capabilities: relayHandshakeCapabilities()
    })
  )
  return true
}

// ── --connect side ──────────────────────────────────────────────────

export type ConnectHandshakeCallbacks = {
  // leftover: bytes buffered after handshake-ok; caller must forward to stdout before attaching the bridge or they're dropped.
  onAccepted: (leftover: Buffer) => void
}

// Why: defense-in-depth prevents a bad .version from pairing incompatible bridge and daemon versions.
export function runConnectHandshake(
  sock: Socket,
  myVersion: string,
  cb: ConnectHandshakeCallbacks,
  endpointCredential?: string
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
        // Why both numbers: with negotiation the daemon's build can legitimately differ from this
        // bridge's, so the version alone no longer says which relay answered.
        process.stderr.write(
          `[relay-connect] Handshake OK at version=${msg.version} protocol=${msg.protocolVersion ?? 'none'}\n`
        )
        handshakeDone = true
        const leftover = decoder.drain()
        sock.removeAllListeners('data')
        cb.onAccepted(leftover)
        return
      }
      if (msg.type === 'orca-relay-handshake-mismatch') {
        // Why: exit inside the write callback; stderr is async on pipe transports, so exiting early drops the version detail.
        process.stderr.write(
          `[relay-connect] Handshake mismatch: expected=${msg.expected}, daemon=${msg.got}, ` +
            `daemonProtocol=${msg.protocolVersion ?? 'none'}, ours=${RELAY_PROTOCOL_VERSION}; ` +
            `exiting ${EXIT_CODE_VERSION_MISMATCH}\n`,
          () => {
            sock.destroy()
            process.exit(EXIT_CODE_VERSION_MISMATCH)
          }
        )
        return
      }
      if (msg.type === 'orca-relay-handshake-credential-mismatch') {
        process.stderr.write(
          `[relay-connect] Endpoint credential refused by daemon; exiting ${EXIT_CODE_CREDENTIAL_MISMATCH}\n`,
          () => {
            sock.destroy()
            process.exit(EXIT_CODE_CREDENTIAL_MISMATCH)
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

  sock.write(
    encodeHandshakeFrame({
      type: 'orca-relay-handshake',
      version: myVersion,
      ...(endpointCredential ? { endpointCredential } : {}),
      // A relay that predates the offer ignores these keys and compares the hash as before.
      ...relayProtocolOffer()
    })
  )
}
