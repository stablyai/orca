import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export function directPathForEndpoint(endpoint: string): Exclude<MobileConnectionPath, 'relay'> {
  try {
    const hostname = new URL(endpoint).hostname
    if (hostname.endsWith('.ts.net') || /^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname)) {
      return 'tailscale'
    }
  } catch {}
  return 'lan'
}

// Why: 'reconnecting' is published on any socket close, so it cannot tell a dead
// LAN (instant 1006, then doomed redials) from one access-point flap that the
// first redial recovers. One redial fits here; a dead LAN still fails in ~2s
// instead of holding the supervisor's operation mutex for the full outer bound.
const RECONNECT_GRACE_MS = 2_000

function waitForAuthenticatedSession(
  session: RpcClient,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('probe cancelled'))
  }
  if (session.getState() === 'connected') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let graceExtended = false
    const armGrace = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        finish()
        reject(new Error('probe session reconnecting'))
      }, RECONNECT_GRACE_MS)
    const unsubscribe = session.onStateChange((state) => {
      if (state === 'connected') {
        finish()
        resolve()
        return
      }
      if (state === 'reconnecting' && !graceTimer) {
        graceTimer = armGrace()
        return
      }
      // Why: the redial fires at 500ms but 'connected' waits on the Noise handshake
      // and a capability RPC. 'handshaking' is proof the peer answered, so extend
      // once; a dead handshake still fails at ~4s, far inside the outer bound.
      if (state === 'handshaking' && graceTimer && !graceExtended) {
        graceExtended = true
        clearTimeout(graceTimer)
        graceTimer = armGrace()
        return
      }
      if (state === 'disconnected' || state === 'auth-failed' || state === 'reconnecting') {
        finish()
        reject(new Error(`probe session ${state}`))
      }
    })
    timer = setTimeout(() => {
      finish()
      reject(new Error('probe session authentication timed out'))
    }, timeoutMs)
    const onAbort = (): void => {
      finish()
      reject(new Error('probe cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish(): void {
      signal?.removeEventListener('abort', onAbort)
      if (timer) {
        clearTimeout(timer)
      }
      if (graceTimer) {
        clearTimeout(graceTimer)
      }
      unsubscribe()
    }
  })
}

export async function openAuthenticatedDirectEndpoint(
  host: HostProfile,
  openDirect: (endpoint: string) => RpcClient,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ client: RpcClient; path: Exclude<MobileConnectionPath, 'relay'> } | null> {
  if (signal?.aborted) {
    return null
  }
  let client: RpcClient
  try {
    client = openDirect(host.endpoint)
  } catch {
    return null
  }
  try {
    await waitForAuthenticatedSession(client, timeoutMs, signal)
  } catch {
    client.close()
    return null
  }
  if (signal?.aborted) {
    client.close()
    return null
  }
  return { client, path: directPathForEndpoint(host.endpoint) }
}
