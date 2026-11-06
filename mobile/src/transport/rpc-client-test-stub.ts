import type { RpcClient } from './rpc-client'

/** A connected RpcClient whose behaviour is only the members a test supplies; an unscripted request rejects. */
export function stubRpcClient(members: Partial<RpcClient> = {}): RpcClient {
  return {
    sendRequest: (method) => Promise.reject(new Error(`unscripted request: ${method}`)),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {},
    ...members
  }
}
