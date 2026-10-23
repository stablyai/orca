// Optional network hardening for the runtime WebSocket listener: TLS, a client allowlist, and a lockout.
import type { IncomingMessage, RequestListener, Server as HttpServer } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { BlockList } from 'node:net'
import type { WebSocket } from 'ws'
import {
  createAllowedClientList,
  isClientAddressAllowed,
  normalizeClientAddress
} from './ws-client-address-policy'
import { readWsTlsCredentials, watchWsTlsCredentials, type WsTlsFiles } from './ws-tls-credentials'
import { UnauthenticatedClientLockout } from './ws-unauthenticated-client-lockout'

/** What an operator asked for, as `orca serve` flags carry it. */
export type RuntimeWsNetworkPolicy = {
  tls?: WsTlsFiles
  /** IPs and CIDR ranges; loopback is always allowed. */
  allowedClients?: readonly string[]
  limitUnauthenticatedClients?: boolean
}

export type WsTransportNetworkGuard = {
  tls?: WsTlsFiles
  allowedClients?: BlockList
  unauthenticatedClientLockout?: UnauthenticatedClientLockout
}

/** Throws on a bad range or an unloadable certificate, so serve fails at startup, not per client. */
export function resolveWsTransportNetworkGuard(
  policy: RuntimeWsNetworkPolicy | undefined
): WsTransportNetworkGuard {
  if (!policy) {
    return {}
  }
  if (policy.tls) {
    readWsTlsCredentials(policy.tls)
  }
  return {
    ...(policy.tls ? { tls: policy.tls } : {}),
    ...(policy.allowedClients
      ? { allowedClients: createAllowedClientList(policy.allowedClients) }
      : {}),
    ...(policy.limitUnauthenticatedClients
      ? { unauthenticatedClientLockout: new UnauthenticatedClientLockout() }
      : {})
  }
}

export type GuardedWsListener = {
  server: HttpServer | HttpsServer
  stopCredentialWatch: () => void
}

export function createGuardedWsListener(
  handler: RequestListener,
  guard: WsTransportNetworkGuard
): GuardedWsListener {
  const tls = guard.tls
  const server = tls
    ? createHttpsServer(readWsTlsCredentials(tls), handler)
    : createHttpServer(handler)
  // Why at TCP accept: a refused peer never reaches TLS, HTTP parsing, or the WebSocket upgrade.
  if (guard.allowedClients || guard.unauthenticatedClientLockout) {
    server.on('connection', (socket) => {
      if (!acceptsClientAddress(guard, socket.remoteAddress)) {
        socket.destroy()
      }
    })
  }
  return {
    server,
    stopCredentialWatch:
      tls && 'setSecureContext' in server ? watchWsTlsCredentials(server, tls) : () => {}
  }
}

function acceptsClientAddress(guard: WsTransportNetworkGuard, rawAddress: string | undefined) {
  if (guard.allowedClients && !isClientAddressAllowed(guard.allowedClients, rawAddress)) {
    return false
  }
  const address = normalizeClientAddress(rawAddress)
  return !(address && guard.unauthenticatedClientLockout?.isBlocked(address))
}

/** Counts a socket against its source when it closes before a device authenticated on it. */
export function trackUnauthenticatedClose(
  guard: WsTransportNetworkGuard,
  ws: WebSocket,
  request: IncomingMessage,
  isAuthenticated: (ws: WebSocket) => boolean
): void {
  const lockout = guard.unauthenticatedClientLockout
  const address = normalizeClientAddress(request.socket.remoteAddress)
  if (!lockout || !address) {
    return
  }
  ws.once('close', () => {
    if (!isAuthenticated(ws)) {
      lockout.recordFailure(address)
    }
  })
}
