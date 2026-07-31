import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

/** Inert initial session while the ordered route owner opens its first candidate. */
export function createPendingRpcClient(): RpcClient {
  let state: ConnectionState = 'connecting'
  const listeners = new Set<(state: ConnectionState) => void>()
  return {
    sendRequest: async () => {
      throw new Error('Connection is not ready')
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyForeground: () => {},
    close() {
      state = 'disconnected'
      for (const listener of listeners) {
        listener(state)
      }
      listeners.clear()
    }
  }
}
