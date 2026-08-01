import { WebSocketServer, type WebSocket } from 'ws'
import type { PeerClientService } from './peer-client-service'
import { E2EEChannel } from './rpc/e2ee-channel'
import { publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../shared/pairing'

// Why: bridges the real server-side E2EEChannel to raw ws frames the same way
// mobile-socket-wiring.ts does, so tests prove PeerClientService speaks the
// actual runtime-rpc handshake/RPC wire protocol, not a stand-in for it.
export function serveOnePeerConnection(
  server: WebSocketServer,
  serverKeys: { publicKey: Uint8Array; secretKey: Uint8Array },
  deviceToken: string
): void {
  server.once('connection', (ws: WebSocket) => {
    const channel = new E2EEChannel(ws, {
      serverSecretKey: serverKeys.secretKey,
      resolveAuthenticatedDevice: (token) =>
        token === deviceToken
          ? { deviceId: 'peer-device-1', deviceToken: token, scope: 'peer' }
          : null,
      onReady: () => {},
      onError: (code, reason) => ws.close(code, reason)
    })
    ws.on('message', (raw, isBinary) =>
      channel.handleRawMessage(isBinary ? (raw as Buffer) : raw.toString())
    )
    ws.on('close', () => channel.destroy())
    channel.onMessage((plaintext, reply) => {
      const request = JSON.parse(plaintext) as { id: string; method: string }
      if (request.method === 'terminal.list') {
        reply(JSON.stringify({ id: request.id, ok: true, result: { terminals: [] } }))
        return
      }
      reply(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'not_found', message: `Unknown method ${request.method}` }
        })
      )
    })
  })
}

export async function startPeerTestServer(): Promise<{
  server: WebSocketServer
  endpoint: string
}> {
  const server = new WebSocketServer({ port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) {
    throw new Error('expected TCP test server')
  }
  return { server, endpoint: `ws://127.0.0.1:${address.port}` }
}

export function waitForPeerClientState(
  service: PeerClientService,
  state: 'connecting' | 'connected' | 'reconnect-wait' | 'closed'
): Promise<void> {
  return new Promise((resolve) => {
    if (service.getStatus().state === state) {
      resolve()
      return
    }
    const unsubscribe = service.onStatusChange((status) => {
      if (status.state === state) {
        unsubscribe()
        resolve()
      }
    })
  })
}

export function makePeerPairingOffer(
  endpoint: string,
  serverKeys: { publicKey: Uint8Array; secretKey: Uint8Array },
  deviceToken: string
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken,
    publicKeyB64: publicKeyToBase64(serverKeys.publicKey),
    scope: 'peer'
  })
}
