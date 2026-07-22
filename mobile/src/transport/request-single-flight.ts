import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

const inFlightRequests = new WeakMap<RpcClient, Map<string, Map<string, Promise<RpcResponse>>>>()

export function sendSingleFlightRequest(
  client: RpcClient,
  hostId: string,
  requestKind: string,
  params?: unknown
): Promise<RpcResponse> {
  let requestsByHost = inFlightRequests.get(client)
  if (!requestsByHost) {
    requestsByHost = new Map()
    inFlightRequests.set(client, requestsByHost)
  }
  let requestsByKind = requestsByHost.get(hostId)
  if (!requestsByKind) {
    requestsByKind = new Map()
    requestsByHost.set(hostId, requestsByKind)
  }

  const existing = requestsByKind.get(requestKind)
  if (existing) {
    return existing
  }

  let request: Promise<RpcResponse>
  try {
    request = client.sendRequest(requestKind, params)
  } catch (error) {
    request = Promise.reject(error)
  }
  requestsByKind.set(requestKind, request)

  const clear = () => {
    if (requestsByKind.get(requestKind) !== request) {
      return
    }
    requestsByKind.delete(requestKind)
    if (requestsByKind.size === 0) {
      requestsByHost.delete(hostId)
    }
    if (requestsByHost.size === 0) {
      inFlightRequests.delete(client)
    }
  }
  void request.then(clear, clear)
  return request
}
