import type { RpcClient } from '../transport/rpc-client'

export function createRpcClientTestDouble(): RpcClient
export function createRpcClientTestDouble<T extends Partial<RpcClient>>(overrides: T): RpcClient & T
export function createRpcClientTestDouble(overrides: Partial<RpcClient> = {}): RpcClient {
  const connectedAt = Date.now()
  const client: RpcClient = {
    sendRequest: () => Promise.reject(new Error('Unconfigured RPC test request')),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => connectedAt,
    getLastInboundAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return Object.assign(client, overrides)
}
