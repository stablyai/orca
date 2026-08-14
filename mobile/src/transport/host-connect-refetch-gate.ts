import type { ConnectionState } from './types'

// Why: a logical client survives socket drops, so screens that fetch once per client latched
// after the first connect and never refreshed after a background/handoff reconnect. Gate the
// refetch on the transition INTO 'connected' — one read per reconnect, no polling timer.
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
