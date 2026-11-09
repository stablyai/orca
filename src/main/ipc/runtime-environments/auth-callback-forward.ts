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
import { BrowserNetworkTunnelClient } from '../../browser/network/tunnels/browser-network-tunnel-client'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'

const ATTACH_TIMEOUT_MS = 20_000

type Tunnel = { client: BrowserNetworkTunnelClient; close: () => void }

/** Opens the host end: a tunnel that reaches only this flow's callback port there. */
async function openHostTunnel(
  userDataPath: string,
  request: AuthCallbackForwardRequest,
  onClosed: () => void
): Promise<Tunnel> {
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
    'network.authCallbackTunnel',
    { flowId: request.flowId },
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
  private tunnel: Tunnel | null = null
  private connections = 0
  private bytes = 0
  private closed = false
  private readonly ttl: ReturnType<typeof setTimeout>

  constructor(
    readonly request: AuthCallbackForwardRequest,
    private readonly onClosed: () => void
  ) {
    this.ttl = setTimeout(() => this.close(), TTL_MS)
  }

  async start(userDataPath: string): Promise<AuthCallbackForwardResult> {
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
      this.tunnel = await openHostTunnel(userDataPath, this.request, () => this.close())
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
    socket.pause()
    this.tunnel.client.open({ host: '127.0.0.1', port: this.request.port }).then(
      (remote) => {
        if (socket.destroyed) {
          remote.destroy()
          return
        }
        socket.on('data', count)
        remote.on('data', count)
        socket.pipe(remote)
        remote.pipe(socket)
        socket.on('error', () => remote.destroy())
        remote.on('error', () => socket.destroy())
        socket.on('close', () => remote.destroy())
        remote.on('close', () => socket.destroy())
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
const keyOf = (request: Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'>): string =>
  `${request.environmentId}\u0000${request.flowId}`

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined
}

function flowOf(
  value: unknown
): Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'> | null {
  const environmentId = field(value, 'environmentId')
  const flowId = field(value, 'flowId')
  return typeof environmentId === 'string' && typeof flowId === 'string'
    ? { environmentId, flowId }
    : null
}

function requestOf(value: unknown): AuthCallbackForwardRequest | null {
  const flow = flowOf(value)
  const port = field(value, 'port')
  return flow &&
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65_535
    ? { ...flow, port }
    : null
}

export function closeAuthCallbackForward(
  request: Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'>
): void {
  forwards.get(keyOf(request))?.close()
}

export async function openAuthCallbackForward(
  userDataPath: string,
  request: AuthCallbackForwardRequest
): Promise<AuthCallbackForwardResult> {
  // A retried sign-in replaces this computer's earlier listener on the same port.
  for (const existing of forwards.values()) {
    if (existing.request.port === request.port) {
      existing.close()
    }
  }
  const key = keyOf(request)
  const forward = new AuthCallbackForward(request, () => {
    if (forwards.get(key) === forward) {
      forwards.delete(key)
    }
  })
  forwards.set(key, forward)
  return forward.start(userDataPath)
}

export function registerAuthCallbackForwardHandlers(getUserDataPath: () => string): void {
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
