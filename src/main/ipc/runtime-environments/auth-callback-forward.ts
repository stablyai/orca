import { GENERIC_RELAY_TTL_MS, isLoopbackCallbackRequest } from './loopback-callback-request'
import { createServer, type Server, type Socket } from 'node:net'
import { ipcMain } from 'electron'
import '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { HOST_ACCOUNT_SIGN_IN_CALLBACK_RUNTIME_CAPABILITY } from '../../../shared/account-runtime-capabilities'
import { BrowserNetworkTunnelEvent } from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  AUTH_CALLBACK_FORWARD_MAX_BYTES as MAX_BYTES,
  AUTH_CALLBACK_FORWARD_MAX_STREAMS as MAX_CONNECTIONS,
  AUTH_CALLBACK_FORWARD_TTL_MS as TTL_MS,
  type AuthCallbackForwardRequest,
  type AuthCallbackForwardResult
} from '../../../shared/auth-callback-forward'
import { flowOf, loopbackRequestOf, requestOf } from './auth-callback-forward-requests'
import { BrowserNetworkTunnelClient } from '../../browser/network/tunnels/browser-network-tunnel-client'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { pipeUpstreamToClient } from '../../browser/network/tunnels/remote-browser-socks-upstream'

const ATTACH_TIMEOUT_MS = 20_000

export type AuthCallbackTunnel = { client: BrowserNetworkTunnelClient; close: () => void }
/** Opens the host end of one sign-in's forward; injectable so tests can wire it in-process. */
export type AuthCallbackTunnelOpener = (onClosed: () => void) => Promise<AuthCallbackTunnel>
/** A sign-in's callback (flowId) or, without one, any OAuth callback an agent on the host listens for. */
export type AuthCallbackForwardTarget = {
  environmentId: string
  port: number
  flowId: string | null
}

/** Opens the host end: a tunnel that reaches only this flow's callback port there. */
async function openHostTunnel(
  userDataPath: string,
  request: AuthCallbackForwardTarget,
  onClosed: () => void
): Promise<AuthCallbackTunnel> {
  await ensureOrcadManagedTunnel(userDataPath, request.environmentId)
  const connection = getPreferredPairedRuntimeConnection(
    resolveEnvironment(userDataPath, request.environmentId)
  )
  const ready = Promise.withResolvers<BrowserNetworkTunnelClient>()
  let client: BrowserNetworkTunnelClient | null = null
  let subscription: RemoteRuntimeTransportSubscription | null = null
  const fail = (error: Error): void => {
    ready.reject(error)
    onClosed()
  }
  subscription = await subscribeRemoteRuntimeTransport(
    connection,
    request.flowId === null ? 'network.loopbackCallbackTunnel' : 'network.authCallbackTunnel',
    request.flowId === null ? { port: request.port } : { flowId: request.flowId },
    ATTACH_TIMEOUT_MS,
    {
      onResponse: (response) => {
        if (!response.ok) {
          fail(new Error(response.error.message))
          return
        }
        const event = BrowserNetworkTunnelEvent.safeParse(response.result)
        if (!event.success || event.data.type === 'closed') {
          fail(new Error('The sign-in tunnel closed.'))
          return
        }
        if (!client) {
          client = new BrowserNetworkTunnelClient({
            tunnelGeneration: event.data.tunnelGeneration,
            sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
            flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
            onClosed: () => onClosed()
          })
          ready.resolve(client)
        }
      },
      onBinary: (bytes) => client?.handleBinary(bytes),
      onError: (error) => fail(error),
      onClose: () => fail(new Error('The sign-in tunnel closed.'))
    },
    {
      perMessageDeflate: false,
      outboundQueue: {
        softCapBytes: MAX_BYTES,
        maxQueuedBytes: 2 * MAX_BYTES,
        maxQueuedFrames: 256,
        maxDrainFramesPerTurn: 4
      },
      clientCapabilities: [
        ...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
        HOST_ACCOUNT_SIGN_IN_CALLBACK_RUNTIME_CAPABILITY
      ]
    }
  )
  const timeout = setTimeout(
    () => ready.reject(new Error('The sign-in tunnel did not open.')),
    ATTACH_TIMEOUT_MS
  )
  try {
    const opened = await ready.promise
    return {
      client: opened,
      close: () => {
        opened.close(new Error('Sign-in finished.'))
        subscription?.close()
      }
    }
  } catch (error) {
    subscription.close()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/** Listens on this computer's loopback callback port for one sign-in and carries each connection to the host. */
export class AuthCallbackForward {
  private readonly servers: Server[] = []
  private readonly sockets = new Set<Socket>()
  private tunnel: AuthCallbackTunnel | null = null
  private connections = 0
  private bytes = 0
  private closed = false
  private readonly ttl: ReturnType<typeof setTimeout>

  constructor(
    readonly request: AuthCallbackForwardTarget,
    private readonly onClosed: () => void
  ) {
    // A generic loopback relay (an MCP server's OAuth redirect, no sign-in flow) lives briefly:
    // the browser hits it within seconds of the user approving.
    const ttlMs = request.flowId === null ? GENERIC_RELAY_TTL_MS : TTL_MS
    this.ttl = setTimeout(() => this.close(), ttlMs)
  }

  async start(openTunnel: AuthCallbackTunnelOpener): Promise<AuthCallbackForwardResult> {
    const v4 = createServer((socket) => this.accept(socket))
    try {
      await listen(v4, this.request.port, '127.0.0.1')
    } catch (error) {
      this.close()
      const busy = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
      return {
        ok: false,
        code: busy ? 'port_busy' : 'listen_failed',
        message: busy
          ? `Port ${this.request.port} is busy on this computer.`
          : 'Orca could not listen for the sign-in on this computer.'
      }
    }
    this.servers.push(v4)
    // Browsers may resolve localhost to ::1 first; a missing IPv6 loopback is fine.
    const v6 = createServer((socket) => this.accept(socket))
    await listen(v6, this.request.port, '::1').then(
      () => this.servers.push(v6),
      () => v6.close()
    )
    try {
      this.tunnel = await openTunnel(() => this.close())
    } catch (error) {
      this.close()
      return {
        ok: false,
        code: 'tunnel_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    if (this.closed) {
      this.tunnel.close()
      return { ok: false, code: 'tunnel_failed', message: 'The sign-in ended.' }
    }
    console.info(`[auth-callback-forward] listening on port ${this.request.port}`)
    return { ok: true }
  }

  private accept(socket: Socket): void {
    this.connections += 1
    if (this.closed || !this.tunnel || this.connections > MAX_CONNECTIONS) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    const count = (chunk: Buffer): void => {
      this.bytes += chunk.byteLength
      if (this.bytes > MAX_BYTES) {
        this.close()
      }
    }
    if (this.request.flowId === null) {
      // Generic relays carry only a browser's OAuth redirect: a GET whose Host is this loopback
      // port. Anything else (DNS rebinding pages, other local processes probing the sandbox's
      // services on that port) is refused before a byte reaches the sandbox.
      socket.on('error', () => socket.destroy())
      socket.once('data', (first: Buffer) => {
        if (!isLoopbackCallbackRequest(first, this.request.port)) {
          socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          return
        }
        socket.pause()
        socket.unshift(first)
        this.pipeToHost(socket, count)
      })
      return
    }
    socket.pause()
    this.pipeToHost(socket, count)
  }

  private pipeToHost(socket: Socket, count: (chunk: Buffer) => void): void {
    if (!this.tunnel) {
      socket.destroy()
      return
    }
    this.tunnel.client.open({ host: '127.0.0.1', port: this.request.port }).then(
      (remote) => {
        if (socket.destroyed) {
          remote.destroy()
          return
        }
        socket.on('data', count)
        remote.on('data', count)
        socket.pipe(remote)
        // Settles each chunk once the local socket took it, returning flow-control credit to the host.
        pipeUpstreamToClient(remote, socket)
        socket.on('error', () => remote.destroy())
        remote.on('error', () => socket.destroy())
        socket.on('close', () => remote.destroy())
        // A finished reply is already ending the socket; destroying it would drop unflushed bytes.
        remote.on('close', () => {
          if (!socket.writableEnded) {
            socket.destroy()
          }
        })
        socket.resume()
      },
      () => socket.destroy()
    )
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    clearTimeout(this.ttl)
    for (const server of this.servers) {
      server.close()
    }
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.tunnel?.close()
    this.onClosed()
    console.info(`[auth-callback-forward] closed port ${this.request.port}`)
  }
}

const forwards = new Map<string, AuthCallbackForward>()
const keyOf = (request: { environmentId: string; flowId: string | null; port?: number }): string =>
  `${request.environmentId}\u0000${request.flowId ?? `port:${request.port}`}`

export function closeAuthCallbackForward(
  request: Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'>
): void {
  forwards.get(keyOf(request))?.close()
}

export async function openAuthCallbackForward(
  userDataPath: string,
  request: AuthCallbackForwardRequest | AuthCallbackForwardTarget
): Promise<AuthCallbackForwardResult> {
  const target: AuthCallbackForwardTarget = { ...request, flowId: request.flowId ?? null }
  // A retried sign-in replaces this computer's earlier listener on the same port, but a generic
  // relay (a clicked MCP OAuth link) never displaces a sign-in in progress.
  for (const existing of forwards.values()) {
    if (existing.request.port !== request.port) {
      continue
    }
    if (target.flowId === null && existing.request.flowId !== null) {
      return { ok: false, code: 'port_busy', message: 'A sign-in is using this port.' }
    }
    existing.close()
  }
  const key = keyOf(target)
  const forward = new AuthCallbackForward(target, () => {
    if (forwards.get(key) === forward) {
      forwards.delete(key)
    }
  })
  forwards.set(key, forward)
  return forward.start((onClosed) => openHostTunnel(userDataPath, target, onClosed))
}

export function registerAuthCallbackForwardHandlers(getUserDataPath: () => string): void {
  // An agent on the host (an MCP server sign-in) waits on its own loopback callback; carry it there.
  ipcMain.handle('runtimeEnvironments:openLoopbackCallbackForward', (_event, value: unknown) => {
    const request = loopbackRequestOf(value)
    return request
      ? openAuthCallbackForward(getUserDataPath(), { ...request, flowId: null })
      : { ok: false, code: 'listen_failed', message: 'Invalid sign-in forward.' }
  })
  ipcMain.handle('runtimeEnvironments:openAuthCallbackForward', (_event, value: unknown) => {
    const request = requestOf(value)
    return request
      ? openAuthCallbackForward(getUserDataPath(), request)
      : { ok: false, code: 'listen_failed', message: 'Invalid sign-in forward.' }
  })
  ipcMain.handle('runtimeEnvironments:closeAuthCallbackForward', (_event, value: unknown) => {
    const flow = flowOf(value)
    if (flow) {
      closeAuthCallbackForward(flow)
    }
  })
}
