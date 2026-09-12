import type { DirectSshAuthority, SshProviderEpoch } from '../../shared/ssh-types'
import type { SshConnection } from '../ssh/ssh-connection'
import type { SshConnectionManager } from '../ssh/ssh-connection-manager'
import { createSsh2ExecutionRoute } from './ssh2-browser-network-execution-route'
import {
  startSystemSshDynamicForwardProcess,
  SystemSshDynamicForwardStartupRetiredError,
  type SystemSshDynamicForwardProcess
} from '../ssh/system-ssh-dynamic-forward-process'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteContext
} from './browser-network-execution-route'
import { SystemSshSocksClientSocket } from './system-ssh-socks-client-socket'
import type { openRegisteredSshNetworkTunnel } from '../ssh/ssh-target-registry'
import { createSshRelayBrowserNetworkRoute } from './ssh-relay-browser-network-route'
import {
  retainSshBrowserRoute,
  type SshBrowserRouteAllocation
} from './ssh-browser-route-lifetimes'
import { SshNetworkTunnelNotAdmittedError } from '../ssh/ssh-relay-network-tunnel-transport'

export type SshBrowserNetworkExecutionRouteDependencies = {
  openNetworkTunnel?: typeof openRegisteredSshNetworkTunnel
  connectionManager: Pick<SshConnectionManager, 'getConnection'>
  isCurrentAuthority: (authority: DirectSshAuthority) => boolean
  registerAuthorityAbort: (authority: DirectSshAuthority, controller: AbortController) => () => void
  startDynamicForward?: (
    connection: SshConnection,
    signal: AbortSignal
  ) => Promise<SystemSshDynamicForwardProcess>
}

export async function resolveSshBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext,
  dependencies: SshBrowserNetworkExecutionRouteDependencies
): Promise<BrowserNetworkExecutionRoute> {
  if (context.executionHost.kind !== 'ssh') {
    throw new Error('browser_tunnel_execution_host_mismatch')
  }
  return retainSshBrowserRoute(context.executionHost.targetId, (allocation) =>
    openSshBrowserNetworkExecutionRoute(context, dependencies, allocation)
  )
}

async function openSshBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext,
  dependencies: SshBrowserNetworkExecutionRouteDependencies,
  allocation: SshBrowserRouteAllocation
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
  const base = {
    key: browserNetworkExecutionHostKey(host),
    authority,
    connection,
    invalidation,
    releaseInvalidation,
    dependencies
  }
  if (dependencies.openNetworkTunnel) {
    allocation.started = true
    let opened: Awaited<ReturnType<typeof openRegisteredSshNetworkTunnel>> | undefined
    try {
      opened = await dependencies.openNetworkTunnel(host.targetId, {
        signal: invalidation.signal,
        onFailure: () => invalidation.abort()
      })
      const tunnel = opened.tunnel
      allocation.resetBinding = { connection, tunnel }
      allocation.retirementConfirmed = () =>
        tunnel.retirementConfirmed === true && !tunnel.resetRetirementRequest
      const assertCurrent = () => {
        if (
          dependencies.connectionManager.getConnection(host.targetId) !== connection ||
          opened?.connection !== connection ||
          !dependencies.isCurrentAuthority(authority)
        ) {
          throw new Error('browser_tunnel_execution_host_stale')
        }
      }
      assertCurrent()
      invalidation.signal.throwIfAborted()
      return createSshRelayBrowserNetworkRoute({
        key: base.key,
        opened,
        signal: invalidation.signal,
        assertCurrent,
        releaseInvalidation
      })
    } catch (error) {
      if (!opened && error instanceof SshNetworkTunnelNotAdmittedError) {
        allocation.started = false
      }
      opened?.tunnel.fail(asError(error))
      releaseInvalidation()
      invalidation.abort()
      throw error
    }
  }
  const client = connection.getClient()
  if (client) {
    allocation.started = true
    return createSsh2ExecutionRoute(base, client)
  }
  if (!connection.usesSystemSshTransport()) {
    releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  try {
    return await connection.prepareForwardRoute(() => {
      allocation.started = true
      return createSystemSshExecutionRoute(base, allocation, dependencies.startDynamicForward)
    })
  } catch (error) {
    releaseInvalidation()
    invalidation.abort()
    throw error
  }
}

export type RouteBase = {
  key: string
  authority: DirectSshAuthority
  connection: SshConnection
  invalidation: AbortController
  releaseInvalidation: () => void
  dependencies: SshBrowserNetworkExecutionRouteDependencies
}

async function createSystemSshExecutionRoute(
  base: RouteBase,
  allocation: SshBrowserRouteAllocation,
  startDynamicForward: SshBrowserNetworkExecutionRouteDependencies['startDynamicForward'] = defaultStartDynamicForward
): Promise<BrowserNetworkExecutionRoute> {
  let forward: SystemSshDynamicForwardProcess
  try {
    forward = await startDynamicForward(base.connection, base.invalidation.signal)
  } catch (error) {
    if (error instanceof SystemSshDynamicForwardStartupRetiredError) {
      allocation.started = false
    }
    throw error
  }
  const sockets = new Set<SystemSshSocksClientSocket>()
  let closed = false
  let closing: Promise<void> | undefined
  const isValid = (): boolean =>
    !closed &&
    !base.invalidation.signal.aborted &&
    forward.process.exitCode === null &&
    forward.process.signalCode === null &&
    base.connection.getState().status === 'connected' &&
    base.dependencies.connectionManager.getConnection(base.authority.targetId) ===
      base.connection &&
    base.dependencies.isCurrentAuthority(base.authority)
  const onExit = (): void => base.invalidation.abort()
  const onError = (): void => base.invalidation.abort()
  forward.process.once('exit', onExit)
  forward.process.once('error', onError)
  if (!isValid()) {
    forward.process.off('exit', onExit)
    forward.process.off('error', onError)
    forward.dispose()
    await forward.close()
    allocation.started = false
    throw new Error('browser_tunnel_execution_host_stale')
  }
  const close = (): Promise<void> => {
    if (closing) {
      return closing
    }
    const completion = Promise.withResolvers<void>()
    closing = completion.promise
    closed = true
    const finish = async () => {
      base.invalidation.abort()
      forward.process.off('exit', onExit)
      forward.process.off('error', onError)
      const closures = [...sockets].map(
        (socket) => new Promise<void>((resolve) => socket.once('close', resolve))
      )
      for (const socket of sockets) {
        socket.destroy()
      }
      forward.dispose()
      await Promise.all([forward.close(), ...closures])
      base.releaseInvalidation()
    }
    void finish().then(completion.resolve, completion.reject)
    return closing
  }
  return {
    key: base.key,
    isValid,
    whenInvalidated: abortPromise(base.invalidation.signal),
    connect: (target) => {
      if (!isValid()) {
        return failedSocket(new Error('browser_tunnel_execution_host_stale'))
      }
      let socket: SystemSshSocksClientSocket
      try {
        socket = base.connection.openForwardSocket(
          () => new SystemSshSocksClientSocket(forward.localPort, target)
        )
      } catch (error) {
        return failedSocket(asError(error))
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      return socket
    },
    close
  }
}

function failedSocket(error: Error): BrowserNetworkDeferredSocket {
  const socket = new BrowserNetworkDeferredSocket()
  queueMicrotask(() => socket.fail(error))
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
