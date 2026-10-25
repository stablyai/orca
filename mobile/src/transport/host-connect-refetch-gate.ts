import type { ConnectionState } from './types'

// Refetch on each transition into connected; logical client identity survives socket replacements.
export function createHostConnectRefetchGate(): {
  observe: (state: ConnectionState) => boolean
} {
  let connected = false
  return {
    observe(state) {
      const nowConnected = state === 'connected'
      const crossedIntoConnected = nowConnected && !connected
      connected = nowConnected
      return crossedIntoConnected
    }
  }
}
