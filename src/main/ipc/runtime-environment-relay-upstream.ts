import WebSocket from 'ws'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyToBase64
} from '../../shared/e2ee-crypto'
import type { RuntimeCapability } from '../../shared/protocol-version'
import { remoteRuntimeConnectOptions } from '../../shared/remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../../shared/remote-runtime-memory-limits'
import {
  parseAuthenticatedFrame,
  parseReadyFrame
} from '../../shared/remote-runtime-request-frames'

// Why short: a direct miss is followed by a Relay attempt inside the same client connect.
const DIRECT_ROUTE_CONNECT_TIMEOUT_MS = 4_000

export type RuntimeRelayBridgeAuthentication = 'authenticated' | 'unauthorized' | 'failed'

/**
 * The host leg behind the bridge, already past transport setup and E2EE key agreement.
 * A direct leg has not yet proven the host key: only `authenticate` does, by the host decrypting it.
 */
export type RuntimeRelayBridgeUpstream = {
  route: 'direct' | 'relay'
  authenticate(
    clientCapabilities: readonly RuntimeCapability[]
  ): Promise<RuntimeRelayBridgeAuthentication>
  sendText(plaintext: string): boolean
  sendBinary(bytes: Uint8Array): boolean
  ping(): void
  close(): void
}

export type RuntimeRelayBridgeUpstreamEvents = {
  onText(plaintext: string): void
  onBinary(bytes: Uint8Array): void
  onPong(): void
  onClose(code: number, reason: string): void
}

export type RuntimeRelayBridgeUpstreamOpen =
  | { ok: true; upstream: RuntimeRelayBridgeUpstream }
  | { ok: false; unauthorized: boolean; message: string }

/** Legacy E2EE to the paired endpoint, as the client stack would speak it without the bridge. */
export function openDirectBridgeUpstream(
  target: { endpoint: string; hostPublicKey: Uint8Array; deviceToken: string },
  events: RuntimeRelayBridgeUpstreamEvents
): Promise<RuntimeRelayBridgeUpstreamOpen> {
  return new Promise((resolve) => {
    const keyPair = generateKeyPair()
    const sharedKey = deriveSharedKey(keyPair.secretKey, target.hostPublicKey)
    let phase: 'connecting' | 'awaiting_ready' | 'keyed' | 'ready' | 'closed' = 'connecting'
    let authWaiter: ((outcome: RuntimeRelayBridgeAuthentication) => void) | null = null
    const ws = new WebSocket(
      target.endpoint,
      remoteRuntimeConnectOptions(
        { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES },
        DIRECT_ROUTE_CONNECT_TIMEOUT_MS
      )
    )
    const keyTimer = setTimeout(
      () => shutdown({ code: 1006, reason: 'Direct route did not complete E2EE setup' }),
      DIRECT_ROUTE_CONNECT_TIMEOUT_MS
    )

    // Why one exit: before key agreement a failure settles the open; after it, the bridge must hear the close.
    function shutdown(outcome: { code: number; reason: string } | null): void {
      if (phase === 'closed') {
        return
      }
      const before = phase
      phase = 'closed'
      clearTimeout(keyTimer)
      ws.removeAllListeners('message')
      ws.on('error', () => {})
      ws.terminate()
      const settleAuth = authWaiter
      settleAuth?.('failed')
      if (before === 'connecting' || before === 'awaiting_ready') {
        resolve({
          ok: false,
          unauthorized: false,
          message: outcome?.reason ?? 'Direct route closed'
        })
      } else if (outcome && !settleAuth) {
        // Why not during auth: a host that is not the paired one closes here, and the bridge
        // must be free to retry through Relay instead of hearing a close.
        events.onClose(outcome.code, outcome.reason)
      }
    }

    const upstream: RuntimeRelayBridgeUpstream = {
      route: 'direct',
      authenticate: (clientCapabilities) =>
        new Promise((settle) => {
          if (phase !== 'keyed') {
            settle('failed')
            return
          }
          // Why: a host that is not the paired one may never answer; fall back before the client times out.
          const authTimer = setTimeout(
            () => shutdown({ code: 1006, reason: 'Direct route did not authenticate' }),
            DIRECT_ROUTE_CONNECT_TIMEOUT_MS
          )
          authWaiter = (outcome) => {
            authWaiter = null
            clearTimeout(authTimer)
            if (outcome === 'authenticated') {
              phase = 'ready'
            }
            settle(outcome)
          }
          const auth = { type: 'e2ee_auth', deviceToken: target.deviceToken, clientCapabilities }
          ws.send(encrypt(JSON.stringify(auth), sharedKey))
        }),
      sendText: (plaintext) => send(encrypt(plaintext, sharedKey)),
      sendBinary: (bytes) => send(Buffer.from(encryptBytes(bytes, sharedKey))),
      ping: () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
        }
      },
      close: () => shutdown(null)
    }

    function send(frame: string | Buffer): boolean {
      if (phase !== 'ready' || ws.readyState !== WebSocket.OPEN) {
        return false
      }
      ws.send(frame, { binary: typeof frame !== 'string' })
      return true
    }

    ws.once('open', () => {
      phase = 'awaiting_ready'
      ws.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keyPair.publicKey) })
      )
    })
    ws.on('message', (data, isBinary) => {
      if (phase === 'awaiting_ready') {
        if (isBinary || parseReadyFrame(data.toString())) {
          shutdown({ code: 1002, reason: 'Direct route returned an invalid E2EE handshake' })
          return
        }
        phase = 'keyed'
        clearTimeout(keyTimer)
        resolve({ ok: true, upstream })
        return
      }
      if (phase === 'keyed' && authWaiter) {
        const plaintext = isBinary ? null : decrypt(data.toString(), sharedKey)
        const error = plaintext === null ? null : parseAuthenticatedFrame(plaintext)
        authWaiter(
          plaintext === null
            ? 'failed'
            : !error
              ? 'authenticated'
              : error.code === 'unauthorized'
                ? 'unauthorized'
                : 'failed'
        )
        return
      }
      if (phase !== 'ready') {
        return
      }
      if (isBinary) {
        const bytes = decryptBytes(
          new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data),
          sharedKey
        )
        if (bytes) {
          events.onBinary(bytes)
        }
        return
      }
      const plaintext = decrypt(data.toString(), sharedKey)
      if (plaintext !== null) {
        events.onText(plaintext)
      }
    })
    ws.on('pong', () => events.onPong())
    ws.on('error', (error) => shutdown({ code: 1006, reason: error.message }))
    ws.on('close', (code, reason) => shutdown({ code, reason: reason.toString() }))
  })
}
