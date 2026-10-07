import WebSocket from 'ws'
import { RelayMovedSchema, RelayPhoneHelloSchema } from '../../shared/mobile-relay-phone-protocol'
import { remoteRuntimeConnectOptions } from '../../shared/remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../../shared/remote-runtime-memory-limits'
import { parseRemoteRuntimeJsonText } from '../../shared/remote-runtime-request-frames'
import { RelayE2EEV2ClientSession } from '../runtime/relay/relay-e2ee-v2-client-session'

const RELAY_LINK_HANDSHAKE_TIMEOUT_MS = 15_000

export type RuntimeRelayLinkCredential = { kind: 'invite' | 'resume'; token: string }

export type RuntimeRelayLinkClose =
  /** The cell or director refused the outer credential with a 44xx relay code. */
  | { kind: 'refused'; code: number }
  /** The director answered an invite with the cell that now owns this host. */
  | { kind: 'moved'; cellUrl: string; assignmentEpoch: number }
  /** The host rejected the device token over E2EE: the grant was revoked. */
  | { kind: 'unauthorized' }
  /** The peer behind Relay does not hold the server key the pairing link pinned. */
  | { kind: 'identity' }
  | { kind: 'closed'; code: number; reason: string }
  | { kind: 'protocol'; message: string }

export type RuntimeRelayLinkHandlers = {
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (bytes: Uint8Array) => void
  onPong?: () => void
  onClose: (close: RuntimeRelayLinkClose) => void
}

export type RuntimeRelayLink = {
  sendText(plaintext: string): boolean
  sendBinary(bytes: Uint8Array): boolean
  ping(): void
  close(): void
}

/** The relay's client connect socket for `relayHostId`, on a cell or on the director. */
export function relayConnectWebSocketUrl(baseUrl: string, relayHostId: string): string {
  const url = new URL(baseUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relayHostId)}`
  return url.toString()
}

type LinkState = 'connecting' | 'awaiting_hello' | 'awaiting_ready' | 'awaiting_auth' | 'ready'

/** One Relay splice to the host: outer credential, then E2EE v2 pinned to `hostPublicKey`. */
export function openRuntimeRelayLink(args: {
  baseUrl: string
  relayHostId: string
  hostPublicKey: Uint8Array
  deviceToken: string
  credential: RuntimeRelayLinkCredential
  handlers: RuntimeRelayLinkHandlers
  // Why: tests dial a local plain-ws relay; production always forces wss.
  connectUrl?: (baseUrl: string, relayHostId: string) => string
}): RuntimeRelayLink {
  const session = new RelayE2EEV2ClientSession(args.hostPublicKey, args.relayHostId)
  const url = (args.connectUrl ?? relayConnectWebSocketUrl)(args.baseUrl, args.relayHostId)
  let state: LinkState = 'connecting'
  let finished = false
  const ws = new WebSocket(
    url,
    remoteRuntimeConnectOptions({
      perMessageDeflate: false,
      maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES
    })
  )
  const handshakeTimer = setTimeout(
    () => finish({ kind: 'protocol', message: 'Orca Relay handshake timed out' }),
    RELAY_LINK_HANDSHAKE_TIMEOUT_MS
  )

  function finish(close: RuntimeRelayLinkClose): void {
    if (finished) {
      return
    }
    finished = true
    clearTimeout(handshakeTimer)
    ws.removeAllListeners('message')
    // Why: a late transport error after we chose the outcome must not become an unhandled event.
    ws.on('error', () => {})
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate()
    }
    args.handlers.onClose(close)
  }

  ws.once('open', () => {
    state = 'awaiting_hello'
    ws.send(
      JSON.stringify({
        type: 'relay-auth',
        v: 1,
        mode: 'connect',
        credential: args.credential.token
      })
    )
  })
  ws.on('message', (data, isBinary) => {
    try {
      handleMessage(data, isBinary)
    } catch (error) {
      finish({ kind: 'protocol', message: error instanceof Error ? error.message : String(error) })
    }
  })
  ws.on('pong', () => args.handlers.onPong?.())
  ws.on('error', (error) => finish({ kind: 'closed', code: 1006, reason: error.message }))
  ws.on('close', (code, reason) => {
    finish(
      code >= 4400 && code < 4600 && state !== 'ready'
        ? { kind: 'refused', code }
        : { kind: 'closed', code, reason: reason.toString() }
    )
  })

  function handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (state === 'ready') {
      if (isBinary) {
        const bytes = session.openBinary(toBytes(data))
        if (!bytes) {
          throw new Error('Orca Relay delivered an undecryptable binary frame')
        }
        args.handlers.onBinary(bytes)
        return
      }
      const plaintext = session.openText(data.toString())
      if (plaintext === null) {
        throw new Error('Orca Relay delivered an undecryptable frame')
      }
      args.handlers.onText(plaintext)
      return
    }
    if (isBinary) {
      throw new Error('Orca Relay sent a binary frame before E2EE was ready')
    }
    const text = data.toString()
    if (state === 'awaiting_hello') {
      acceptOuterHello(parseRemoteRuntimeJsonText(text))
    } else if (state === 'awaiting_ready') {
      if (!session.acceptReady(parseRemoteRuntimeJsonText(text))) {
        finish({ kind: 'identity' })
        return
      }
      state = 'awaiting_auth'
      ws.send(session.authFrame(args.deviceToken))
    } else if (state === 'awaiting_auth') {
      acceptAuthentication(session.openText(text))
    }
  }

  function acceptOuterHello(value: unknown): void {
    const moved = RelayMovedSchema.safeParse(value)
    if (moved.success) {
      finish({
        kind: 'moved',
        cellUrl: moved.data.cellUrl,
        assignmentEpoch: moved.data.assignmentEpoch
      })
      return
    }
    const hello = RelayPhoneHelloSchema.parse(value)
    if (!hello.ok) {
      finish({ kind: 'refused', code: hello.code })
      return
    }
    if (hello.credentialKind !== args.credential.kind) {
      throw new Error('Orca Relay resolved the credential as an unexpected kind')
    }
    state = 'awaiting_ready'
    ws.send(JSON.stringify(session.hello))
  }

  function acceptAuthentication(plaintext: string | null): void {
    const outcome = plaintext === null ? 'invalid' : session.readAuthentication(plaintext)
    if (outcome === 'unauthorized') {
      finish({ kind: 'unauthorized' })
      return
    }
    if (outcome !== 'authenticated') {
      throw new Error('Orca server rejected the Relay E2EE handshake')
    }
    state = 'ready'
    clearTimeout(handshakeTimer)
    args.handlers.onAuthenticated()
  }

  return {
    sendText: (plaintext) => send(session.sealText(plaintext)),
    sendBinary: (bytes) => send(Buffer.from(session.sealBinary(bytes))),
    ping: () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    },
    close: () => finish({ kind: 'closed', code: 1000, reason: 'client closed' })
  }

  function send(frame: string | Buffer): boolean {
    if (finished || state !== 'ready' || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(frame, { binary: typeof frame !== 'string' })
    return true
  }
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  return new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data)
}
