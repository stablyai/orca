import type { DirectSshAuthority, SshProviderEpoch } from '../../shared/ssh-types'
import type { SshConnection } from '../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../ssh/connection/ssh-connection-manager'
import type { Client as SshClient, ClientChannel } from 'ssh2'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import {
  loadHostProxyEnvironment,
  readSshHostProxyEnvironment
} from '../ssh/ssh-host-proxy-environment'
import {
  startSystemSshDynamicForwardProcess,
  type SystemSshDynamicForwardProcess
} from '../ssh/system-transport/system-ssh-dynamic-forward-process'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteContext,
  openConnectedSocket
} from './browser-network-execution-route'
import {
  connectThroughBrowserNetworkTunnelProxy,
  type BrowserNetworkTunnelDialer
} from './browser-network-tunnel-proxy-connect'
import {
  selectBrowserNetworkTunnelProxy,
  type BrowserNetworkTunnelProxy
} from './browser-network-tunnel-proxy-selection'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import { openExecutionRouteSocketAsDuplex } from './execution-route-socket-duplex'
import { SystemSshSocksClientSocket } from './system-ssh-socks-client-socket'

export type SshBrowserNetworkExecutionRouteDependencies = {
  connectionManager: Pick<SshConnectionManager, 'getConnection'>
  isCurrentAuthority: (authority: DirectSshAuthority) => boolean
  registerAuthorityAbort: (authority: DirectSshAuthority, controller: AbortController) => () => void
  startDynamicForward?: (
    connection: SshConnection,
    signal: AbortSignal
  ) => Promise<SystemSshDynamicForwardProcess>
  readHostProxyEnvironment?: (
    connection: SshConnection,
    signal: AbortSignal
  ) => Promise<Record<string, string>>
}

export async function resolveSshBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext,
  dependencies: SshBrowserNetworkExecutionRouteDependencies
): Promise<BrowserNetworkExecutionRoute> {
  const host = context.executionHost
  if (host.kind !== 'ssh') {
    throw new Error('browser_tunnel_execution_host_mismatch')
  }
  const authority: DirectSshAuthority = {
    targetId: host.targetId,
    providerEpoch: host.providerEpoch as SshProviderEpoch,
    connectionGeneration: host.connectionGeneration
  }
  const connection = dependencies.connectionManager.getConnection(host.targetId)
  if (
    connection?.getState().status !== 'connected' ||
    !dependencies.isCurrentAuthority(authority)
  ) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  const invalidation = new AbortController()
  const removeAuthorityAbort = dependencies.registerAuthorityAbort(authority, invalidation)
  const abortFromContext = (): void => invalidation.abort()
  context.signal?.addEventListener('abort', abortFromContext, { once: true })
  const releaseInvalidation = (): void => {
    context.signal?.removeEventListener('abort', abortFromContext)
    removeAuthorityAbort()
  }
  if (context.signal?.aborted) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  if (!dependencies.isCurrentAuthority(authority)) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  const hostProxyEnvironment = await loadHostProxyEnvironment(
    (signal) =>
      (dependencies.readHostProxyEnvironment ?? readSshHostProxyEnvironment)(connection, signal),
    invalidation.signal
  )
  if (invalidation.signal.aborted) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  if (!dependencies.isCurrentAuthority(authority)) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  const base = {
    key: browserNetworkExecutionHostKey(host),
    authority,
    connection,
    invalidation,
    releaseInvalidation,
    dependencies,
    // Destinations leave from the host, so the host's proxy applies, never this machine's Orca setting.
    selectProxy: (target: BrowserNetworkTunnelOpen) =>
      selectBrowserNetworkTunnelProxy(target, null, hostProxyEnvironment())
  }
  const client = connection.getClient()
  if (client) {
    return createSsh2ExecutionRoute(base, client)
  }
  if (!connection.usesSystemSshTransport()) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  return createSystemSshExecutionRoute(base, dependencies.startDynamicForward)
}

type RouteBase = {
  key: string
  authority: DirectSshAuthority
  connection: SshConnection
  invalidation: AbortController
  releaseInvalidation: () => void
  dependencies: SshBrowserNetworkExecutionRouteDependencies
  selectProxy: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelProxy
}

function createSsh2ExecutionRoute(
  base: RouteBase,
  client: SshClient
): BrowserNetworkExecutionRoute {
  const sockets = new Set<BrowserNetworkTunnelSocket>()
  let closed = false
  const isValid = (): boolean =>
    !closed &&
    !base.invalidation.signal.aborted &&
    base.connection.getClient() === client &&
    base.connection.getState().status === 'connected' &&
    base.dependencies.connectionManager.getConnection(base.authority.targetId) ===
      base.connection &&
    base.dependencies.isCurrentAuthority(base.authority)
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    base.releaseInvalidation()
    base.invalidation.abort()
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
  }
  const forwardOut = (target: BrowserNetworkTunnelOpen): Promise<ClientChannel> =>
    new Promise((resolve, reject) => {
      if (!isValid()) {
        reject(new Error('browser_tunnel_execution_host_stale'))
        return
      }
      client.forwardOut('127.0.0.1', 0, target.host, target.port, (error, channel) => {
        if (error) {
          reject(error)
        } else if (!isValid()) {
          channel.close()
          reject(new Error('browser_tunnel_execution_host_stale'))
        } else {
          resolve(channel)
        }
      })
    })
  const dialer: BrowserNetworkTunnelDialer = {
    connect: (target) => {
      const socket = new BrowserNetworkDeferredSocket()
      forwardOut(target).then(
        (channel) => socket.attach(channel),
        (error: unknown) => socket.fail(asError(error))
      )
      return socket
    },
    openTransport: forwardOut
  }
  return {
    key: base.key,
    isValid,
    whenInvalidated: abortPromise(base.invalidation.signal),
    connect: (target) => track(sockets, connectFromHost(base, dialer, target)),
    close
  }
}

async function createSystemSshExecutionRoute(
  base: RouteBase,
  startDynamicForward: SshBrowserNetworkExecutionRouteDependencies['startDynamicForward'] = defaultStartDynamicForward
): Promise<BrowserNetworkExecutionRoute> {
  let forward: SystemSshDynamicForwardProcess
  try {
    forward = await startDynamicForward(base.connection, base.invalidation.signal)
  } catch (error) {
    base.releaseInvalidation()
    base.invalidation.abort()
    throw error
  }
  const sockets = new Set<BrowserNetworkTunnelSocket>()
  let closed = false
  const isValid = (): boolean =>
    !closed &&
    !base.invalidation.signal.aborted &&
    forward.process.exitCode === null &&
    forward.process.signalCode === null &&
    base.connection.getState().status === 'connected' &&
    base.dependencies.connectionManager.getConnection(base.authority.targetId) ===
      base.connection &&
    base.dependencies.isCurrentAuthority(base.authority)
  const forwardTo = (target: BrowserNetworkTunnelOpen): SystemSshSocksClientSocket =>
    new SystemSshSocksClientSocket(target, (signal) =>
      openConnectedSocket({ host: '127.0.0.1', port: forward.localPort }, signal)
    )
  const dialer: BrowserNetworkTunnelDialer = {
    connect: forwardTo,
    openTransport: (endpoint, signal) => {
      const socket = forwardTo(endpoint)
      signal.addEventListener('abort', () => socket.destroy(), { once: true })
      return openExecutionRouteSocketAsDuplex(socket)
    }
  }
  const onExit = (): void => base.invalidation.abort()
  const onError = (): void => base.invalidation.abort()
  forward.process.once('exit', onExit)
  forward.process.once('error', onError)
  if (!isValid()) {
    forward.process.off('exit', onExit)
    forward.process.off('error', onError)
    forward.dispose()
    await forward.close()
    base.releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    base.releaseInvalidation()
    base.invalidation.abort()
    forward.process.off('exit', onExit)
    forward.process.off('error', onError)
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
    forward.dispose()
    await forward.close()
  }
  return {
    key: base.key,
    isValid,
    whenInvalidated: abortPromise(base.invalidation.signal),
    connect: (target) => {
      if (!isValid()) {
        // A bare destroy reaches the session as a pre-connect close; its siblings all fail loudly.
        const socket = new BrowserNetworkDeferredSocket()
        queueMicrotask(() => socket.fail(new Error('browser_tunnel_execution_host_stale')))
        return socket
      }
      return track(sockets, connectFromHost(base, dialer, target))
    },
    close
  }
}

/** Dials from the host through its proxy, so a host that only reaches the internet that way still browses. */
function connectFromHost(
  base: RouteBase,
  dialer: BrowserNetworkTunnelDialer,
  target: BrowserNetworkTunnelOpen
): BrowserNetworkTunnelSocket {
  return connectThroughBrowserNetworkTunnelProxy(target, base.selectProxy(target), dialer)
}

function track(
  sockets: Set<BrowserNetworkTunnelSocket>,
  socket: BrowserNetworkTunnelSocket
): BrowserNetworkTunnelSocket {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  return socket
}

function defaultStartDynamicForward(
  connection: SshConnection,
  signal: AbortSignal
): Promise<SystemSshDynamicForwardProcess> {
  return startSystemSshDynamicForwardProcess(
    connection.getTarget(),
    connection.getSystemSshBuildArgsOptions(),
    signal
  )
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
