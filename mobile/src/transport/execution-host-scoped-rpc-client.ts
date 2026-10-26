import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { RpcClient } from './rpc-client'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'

const scopedViews = new WeakMap<RpcClient, Map<ExecutionHostId, RpcClient>>()

// Server calls need both desktop relay support and a transport carrying executionHost; older shells cannot forward the envelope.
export function relaysToServers(client: RpcClient, hostCapabilities: readonly string[]): boolean {
  return (
    hostCapabilities.includes(MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY) &&
    (client.carriesRpcEnvelope?.() ?? true)
  )
}

// Undefined selects the desktop; null refuses an unreachable server workspace.
export function workspaceRouteExecutionHost(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): ExecutionHostId | undefined | null {
  if (!executionHost?.startsWith('runtime:')) {
    return undefined
  }
  return client && relaysToServers(client, hostCapabilities) ? executionHost : null
}

function onExecutionHost<Options extends { envelope?: RpcEnvelopeFields }>(
  options: Options | undefined,
  executionHost: ExecutionHostId | undefined
): Options | { envelope: RpcEnvelopeFields } | undefined {
  return executionHost ? { ...options, envelope: { ...options?.envelope, executionHost } } : options
}

// Route calls by params without owning the connection; close must leave the shared client open.
export function routeRpcClientCalls(
  client: RpcClient,
  hostOf: (params: unknown) => ExecutionHostId | undefined
): RpcClient {
  return {
    sendRequest: (method, params, options) =>
      client.sendRequest(method, params, onExecutionHost(options, hostOf(params))),
    subscribe: (method, params, onData, options) =>
      client.subscribe(method, params, onData, onExecutionHost(options, hostOf(params))),
    updateTerminalSubscriptionViewport: (terminal, viewport) =>
      client.updateTerminalSubscriptionViewport(terminal, viewport),
    getState: () => client.getState(),
    getReconnectAttempt: () => client.getReconnectAttempt(),
    getLastConnectedAt: () => client.getLastConnectedAt(),
    getLastInboundAt: client.getLastInboundAt && (() => client.getLastInboundAt?.() ?? null),
    getGeneration: client.getGeneration && (() => client.getGeneration?.() ?? 0),
    carriesRpcEnvelope: client.carriesRpcEnvelope && (() => client.carriesRpcEnvelope?.() ?? true),
    onStateChange: (listener) => client.onStateChange(listener),
    notifyForeground: (reason) => client.notifyForeground(reason),
    close: () => {}
  }
}

// Cache by client/host so scoped views preserve the identity screens compare.
export function scopeRpcClientToExecutionHost(
  client: RpcClient,
  executionHost: ExecutionHostId
): RpcClient {
  let views = scopedViews.get(client)
  if (!views) {
    views = new Map()
    scopedViews.set(client, views)
  }
  const existing = views.get(executionHost)
  if (existing) {
    return existing
  }
  const view = routeRpcClientCalls(client, () => executionHost)
  views.set(executionHost, view)
  return view
}

// Return null for unreachable servers; falling back to the desktop would execute workspace calls on the wrong computer.
export function rpcClientForExecutionHost(
  client: RpcClient,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): RpcClient | null {
  const routeHost = workspaceRouteExecutionHost(client, hostCapabilities, executionHost)
  if (routeHost === undefined) {
    return client
  }
  return routeHost && scopeRpcClientToExecutionHost(client, routeHost)
}

export function reachableServerClients(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  hosts: readonly { hostId: `runtime:${string}`; relay: string }[]
): ReadonlyMap<ExecutionHostId, RpcClient> {
  const clients = new Map<ExecutionHostId, RpcClient>()
  if (!client || !relaysToServers(client, hostCapabilities)) {
    return clients
  }
  for (const host of hosts) {
    if (host.relay === 'ready') {
      clients.set(host.hostId, scopeRpcClientToExecutionHost(client, host.hostId))
    }
  }
  return clients
}
