import type {
  DirectSshAuthority,
  SshProviderEpoch
} from '../../../../shared/remote-runtime/ssh/ssh-types'
import type { SshConnection } from '../../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../../ssh/connection/ssh-connection-manager'
import type { Client as SshClient, ClientChannel } from 'ssh2'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import {
  loadHostProxyEnvironment,
  readSshHostProxyEnvironment
} from '../../../ssh/remote-host/ssh-host-proxy-environment'
import {
  startSystemSshDynamicForwardProcess,
  type SystemSshDynamicForwardProcess
} from '../../../ssh/system-transport/forwarding/system-ssh-dynamic-forward-process'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import './browser-network-execution-route'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import type {
  BrowserNetworkExecutionRoute,
  BrowserNetworkExecutionRouteContext
} from './browser-network-execution-route-contract'
import { openConnectedSocket } from '../tunnels/browser-network-connected-socket'
import { selectBrowserNetworkTunnelProxy } from '../tunnels/browser-network-tunnel-proxy-selection'
import { openExecutionRouteSocketAsDuplex } from '../tunnels/execution-route-socket-duplex'
import { SystemSshSocksClientSocket } from '../tunnels/system-ssh-socks-client-socket'
import { probeSsh2BrowserEgress, probeSystemSshBrowserEgress } from './ssh-browser-egress-probe'
import {
  createSshHostRelayRoute,
  launchSshBrowserNetworkHostRelay,
  type LaunchHostRelay
} from './ssh-browser-network-host-relay'
import {
  finishSshBrowserNetworkRoute,
  isSshBrowserNetworkRouteBaseCurrent,
  type SshBrowserNetworkRouteBase
} from './ssh-browser-network-route-base'

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
  launchHostRelay?: LaunchHostRelay
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
  const base: SshBrowserNetworkRouteBase = {
    key: browserNetworkExecutionHostKey(host),
    authority,
    connection,
    invalidation,
    releaseInvalidation,
    connectionManager: dependencies.connectionManager,
    isCurrentAuthority: dependencies.isCurrentAuthority,
    // Destinations leave from the host, so the host's proxy applies, never this machine's Orca setting.
    selectProxy: (target: BrowserNetworkTunnelOpen) =>
      selectBrowserNetworkTunnelProxy(target, null, hostProxyEnvironment())
  }
  const launchHostRelay = dependencies.launchHostRelay ?? launchSshBrowserNetworkHostRelay
  const client = connection.getClient()
  if (client) {
    // Once per route, never per connection: hosts that forward normally keep forwarding directly.
    if ((await probeSsh2BrowserEgress(connection)) === 'refused') {
      return (
        (await createSshHostRelayRoute(base, launchHostRelay)) ??
        createSsh2ExecutionRoute(base, client, true)
      )
    }
    return createSsh2ExecutionRoute(base, client, false)
  }
  if (!connection.usesSystemSshTransport()) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  return createSystemSshExecutionRoute(
    base,
    dependencies.startDynamicForward ?? defaultStartDynamicForward,
    launchHostRelay
  )
}

function createSsh2ExecutionRoute(
  base: SshBrowserNetworkRouteBase,
  client: SshClient,
  forwardingBlocked: boolean
): BrowserNetworkExecutionRoute {
  const isCurrent = (): boolean =>
    isSshBrowserNetworkRouteBaseCurrent(base) && base.connection.getClient() === client
  const forwardOut = (target: BrowserNetworkTunnelOpen): Promise<ClientChannel> =>
    new Promise((resolve, reject) => {
      if (!isCurrent()) {
        reject(new Error('browser_tunnel_execution_host_stale'))
        return
      }
      client.forwardOut('127.0.0.1', 0, target.host, target.port, (error, channel) => {
        if (error) {
          reject(error)
        } else if (!isCurrent()) {
          channel.close()
          reject(new Error('browser_tunnel_execution_host_stale'))
        } else {
          resolve(channel)
        }
      })
    })
  return finishSshBrowserNetworkRoute(base, {
    isValid: () => base.connection.getClient() === client,
    forwardingBlocked,
    dialer: {
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
  })
}

async function createSystemSshExecutionRoute(
  base: SshBrowserNetworkRouteBase,
  startDynamicForward: NonNullable<
    SshBrowserNetworkExecutionRouteDependencies['startDynamicForward']
  >,
  launchHostRelay: LaunchHostRelay
): Promise<BrowserNetworkExecutionRoute> {
  let forward: SystemSshDynamicForwardProcess
  try {
    forward = await startDynamicForward(base.connection, base.invalidation.signal)
  } catch (error) {
    base.releaseInvalidation()
    base.invalidation.abort()
    throw error
  }
  const stopForward = async (): Promise<void> => {
    forward.dispose()
    await forward.close()
  }
  let forwardingBlocked = false
  if ((await probeSystemSshBrowserEgress(forward)) === 'refused') {
    const relay = await createSshHostRelayRoute(base, launchHostRelay).catch(
      async (error: unknown) => {
        await stopForward()
        throw error
      }
    )
    if (relay) {
      await stopForward()
      return relay
    }
    forwardingBlocked = true
  }
  const forwardAlive = (): boolean =>
    forward.process.exitCode === null && forward.process.signalCode === null
  const forwardTo = (target: BrowserNetworkTunnelOpen): SystemSshSocksClientSocket =>
    new SystemSshSocksClientSocket(target, (signal) =>
      openConnectedSocket({ host: '127.0.0.1', port: forward.localPort }, signal)
    )
  const onExit = (): void => base.invalidation.abort()
  const onError = (): void => base.invalidation.abort()
  forward.process.once('exit', onExit)
  forward.process.once('error', onError)
  const closeForward = async (): Promise<void> => {
    forward.process.off('exit', onExit)
    forward.process.off('error', onError)
    await stopForward()
  }
  if (!isSshBrowserNetworkRouteBaseCurrent(base) || !forwardAlive()) {
    await closeForward()
    base.releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  return finishSshBrowserNetworkRoute(base, {
    isValid: forwardAlive,
    forwardingBlocked,
    close: closeForward,
    dialer: {
      connect: forwardTo,
      openTransport: (endpoint, signal) => {
        const socket = forwardTo(endpoint)
        signal.addEventListener('abort', () => socket.destroy(), { once: true })
        return openExecutionRouteSocketAsDuplex(socket)
      }
    }
  })
}

function defaultStartDynamicForward(
  connection: SshConnection,
  signal: AbortSignal
): Promise<SystemSshDynamicForwardProcess> {
  return startSystemSshDynamicForwardProcess(
    connection.getTarget(),
    // The egress probe reads the host's answer from stderr, which a quiet LogLevel would hide.
    { ...connection.getSystemSshBuildArgsOptions(), logChannelFailures: true },
    signal
  )
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
