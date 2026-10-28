import type { RpcClient } from './rpc-client'

// Wait for recovery before replaying idempotent work; a dead relay rejects immediately and would consume replay budget.
// Intermediate disconnect/reconnect states are expected; only revoked pairing or timeout fails this wait.
export function waitForRpcClientReconnected(
  client: RpcClient,
  timeoutMs: number
): Promise<boolean> {
  const state = client.getState()
  if (state === 'connected') {
    return Promise.resolve(true)
  }
  if (state === 'auth-failed') {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    // Armed before subscribing so a synchronous notification during registration
    // still finds a timer to clear.
    const timer = setTimeout(() => finish(false), timeoutMs)
    unsubscribe = client.onStateChange((state) => {
      if (state === 'connected') {
        finish(true)
      } else if (state === 'auth-failed') {
        // Revoked pairing never reaches 'connected', so waiting out the timeout only
        // delays the error the caller is going to surface anyway.
        finish(false)
      }
    })
    if (settled) {
      // The notification fired inside onStateChange, before we held the handle.
      unsubscribe()
      unsubscribe = null
    }

    function finish(reconnected: boolean): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      unsubscribe = null
      resolve(reconnected)
    }
  })
}
