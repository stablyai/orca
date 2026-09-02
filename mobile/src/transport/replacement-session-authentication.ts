import type { RpcClient } from './rpc-client'

// Why: a migration must not cut over to a session that has only opened a socket — the
// replacement has to reach 'connected' (E2EE authenticated) first, and a relay dial can
// sit in handshaking for seconds, so the wait is bounded by the caller's timeout.
export function waitForAuthenticated(session: RpcClient, timeoutMs: number): Promise<void> {
  if (session.getState() === 'connected') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    // Why: armed before subscribing — a synchronous notification during registration
    // must find a timer to clear, or a settled wait leaves it running for 12s.
    const timer = setTimeout(() => {
      finish()
      reject(new Error('replacement session authentication timed out'))
    }, timeoutMs)
    unsubscribe = session.onStateChange((state) => {
      if (state === 'connected') {
        finish()
        resolve()
      } else if (state === 'auth-failed' || state === 'disconnected') {
        finish()
        reject(new Error(`replacement session ${state}`))
      }
    })
    if (settled) {
      // Why: the notification fired inside onStateChange, before we held the handle.
      unsubscribe()
      unsubscribe = null
    }

    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      unsubscribe = null
    }
  })
}
