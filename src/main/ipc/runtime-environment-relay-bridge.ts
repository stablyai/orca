import { createServer, type IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../../shared/remote-runtime-memory-limits'
import { registerRemoteRuntimeSocketConnector } from '../../shared/remote-runtime-socket-connector'
import { RuntimeRelayBridgeSession } from './runtime-environment-relay-bridge-session'
import {
  openRelayBridgeUpstream,
  type RuntimeRelayBridgeRelayTarget
} from './runtime-environment-relay-link-upstream'
import {
  openDirectBridgeUpstream,
  type RuntimeRelayBridgeUpstreamEvents,
  type RuntimeRelayBridgeUpstreamOpen
} from './runtime-environment-relay-upstream'

// Why: after a direct miss, stay on Relay for a while instead of paying the direct timeout per socket.
const RELAY_ROUTE_PREFERENCE_MS = 5 * 60_000

export type RuntimeEnvironmentRelayBridgeTarget = RuntimeRelayBridgeRelayTarget & {
  environmentId: string
  /** Null when the paired endpoint is only reachable from the server itself. */
  directEndpoint: string | null
}

/**
 * One per Relay-capable environment: the client stack dials `endpoint`, and every socket
 * is answered in-process and carried to the server directly or through Orca Relay.
 */
export class RuntimeEnvironmentRelayBridge {
  readonly endpoint: string
  readonly publicKeyB64: string
  private readonly keyPair = generateKeyPair()
  private readonly http = createServer()
  private readonly wss = new WebSocketServer({
    noServer: true,
    autoPong: false,
    perMessageDeflate: false,
    maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES
  })
  private readonly clients = new Set<WebSocket>()
  private readonly unregisterConnector: () => void
  private relayPreferredUntil = 0
  private disposed = false
  /** Route of the most recent host connection, shown beside the server's status. */
  activeRoute: 'direct' | 'relay' | null = null

  constructor(private readonly target: RuntimeEnvironmentRelayBridgeTarget) {
    this.publicKeyB64 = publicKeyToBase64(this.keyPair.publicKey)
    // Why .invalid: should the connector ever be missing, this name can never reach a real host.
    this.endpoint = `ws://relay.orca.invalid/${encodeURIComponent(target.environmentId)}`
    this.http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.acceptUpgrade(request, socket, head)
    })
    this.http.on('clientError', (_error, socket) => socket.destroy())
    this.unregisterConnector = registerRemoteRuntimeSocketConnector(this.endpoint, () => {
      const [client, server] = createInProcessSocketPair()
      this.http.emit('connection', server)
      return client
    })
  }

  dispose(): void {
    this.disposed = true
    this.unregisterConnector()
    for (const client of this.clients) {
      client.terminate()
    }
    this.clients.clear()
    this.wss.close()
  }

  private async acceptUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const session = new RuntimeRelayBridgeSession(this.keyPair, this.target.deviceToken, {
      fallBackToRelay: (events) => {
        this.relayPreferredUntil = Date.now() + RELAY_ROUTE_PREFERENCE_MS
        return openRelayBridgeUpstream(this.target, events)
      },
      onAuthenticated: (route) => {
        this.activeRoute = route
      }
    })
    const opened = await this.openUpstream(session.upstreamEvents)
    if (this.disposed || socket.destroyed || (!opened.ok && !opened.unauthorized)) {
      if (opened.ok) {
        opened.upstream.close()
      }
      // Why 503: the client stack reports a refused upgrade as an unreachable host and retries.
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
      )
      return
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.clients.add(ws)
      ws.once('close', () => this.clients.delete(ws))
      session.attach(ws, opened)
    })
  }

  private async openUpstream(
    events: RuntimeRelayBridgeUpstreamEvents
  ): Promise<RuntimeRelayBridgeUpstreamOpen> {
    const directEndpoint = this.target.directEndpoint
    const openDirect = (endpoint: string) =>
      openDirectBridgeUpstream(
        {
          endpoint,
          hostPublicKey: this.target.hostPublicKey,
          deviceToken: this.target.deviceToken
        },
        events
      )
    const directFirst = directEndpoint !== null && Date.now() >= this.relayPreferredUntil
    if (directFirst) {
      const direct = await openDirect(directEndpoint)
      if (direct.ok || direct.unauthorized) {
        return direct
      }
      this.relayPreferredUntil = Date.now() + RELAY_ROUTE_PREFERENCE_MS
    }
    const relay = await openRelayBridgeUpstream(this.target, events)
    if (relay.ok || relay.unauthorized || directFirst || directEndpoint === null) {
      return relay
    }
    // Why: Relay failing while direct was skipped may mean the network changed back.
    const direct = await openDirect(directEndpoint)
    if (direct.ok) {
      this.relayPreferredUntil = 0
    }
    return direct.ok || direct.unauthorized ? direct : relay
  }
}

function createInProcessSocketPair(): [Duplex, Duplex] {
  let client: Duplex | null = null
  let server: Duplex | null = null
  const end = (peer: () => Duplex | null) =>
    new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const target = peer()
        if (target && !target.destroyed) {
          target.push(chunk)
        }
        callback()
      },
      final(callback) {
        peer()?.push(null)
        callback()
      },
      destroy(error, callback) {
        const target = peer()
        if (target && !target.destroyed) {
          target.push(null)
        }
        callback(error)
      }
    })
  client = end(() => server)
  server = end(() => client)
  return [client, server]
}
