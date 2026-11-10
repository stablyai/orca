import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const readViews = new WeakMap<RpcClient, RpcClient>()
const viewBases = new WeakMap<object, RpcClient>()

/** The client a read view was made from, or the client itself; per-connection state keys on this. */
export function readViewBase<T extends object>(client: T): T | RpcClient {
  return viewBases.get(client) ?? client
}

// Query reads reject at once while the host is down instead of queueing for the reconnect; the connected edge refetches them.
// Memoized per client: loaders key delta baselines and in-flight joins on the client object.
export function hostReadClient(client: RpcClient): RpcClient {
  const existing = readViews.get(client)
  if (existing) {
    return existing
  }
  const requestRoute = client.requestRoute
  // Built like routeRpcClientCalls: delegate every member, and never own the shared connection.
  const view: RpcClient = {
    requestRoute:
      requestRoute &&
      ((params) => {
        const route = requestRoute.call(client, params)
        return { ...route, client: hostReadClient(route.client) }
      }),
    sendRequest: (method, params, options) =>
      client.sendRequest(method, params, { ...options, failWhenDisconnected: true }),
    subscribe: (method, params, onData, options) =>
      client.subscribe(method, params, onData, options),
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
    probeLivenessNow: client.probeLivenessNow && (() => client.probeLivenessNow?.()),
    close: () => {}
  }
  readViews.set(client, view)
  viewBases.set(view, client)
  return view
}
