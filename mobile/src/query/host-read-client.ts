import type { RpcClient } from '../transport/rpc-client'

const readViews = new WeakMap<RpcClient, RpcClient>()

// Query reads reject at once while the host is down instead of queueing for the reconnect; the connected edge refetches them.
// Memoized per client: loaders key delta baselines and in-flight joins on the client object.
export function hostReadClient(client: RpcClient): RpcClient {
  const existing = readViews.get(client)
  if (existing) {
    return existing
  }
  const view = new Proxy(client, {
    get(target, property) {
      if (property === 'sendRequest') {
        const sendFailFast: RpcClient['sendRequest'] = (method, params, options) =>
          target.sendRequest(method, params, { ...options, failWhenDisconnected: true })
        return sendFailFast
      }
      const requestRoute = target.requestRoute
      if (property === 'requestRoute' && requestRoute) {
        const routeFailFast: typeof requestRoute = (params) => {
          const route = requestRoute.call(target, params)
          return { ...route, client: hostReadClient(route.client) }
        }
        return routeFailFast
      }
      const value: unknown = Reflect.get(target, property)
      // Bind so class clients keep their private fields.
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  readViews.set(client, view)
  return view
}
