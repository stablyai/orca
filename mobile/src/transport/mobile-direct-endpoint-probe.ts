import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function directPathForEndpoint(endpoint: string): Exclude<MobileConnectionPath, 'relay'> {
  return isTailscaleEndpoint(endpoint) ? 'tailscale' : 'lan'
}

// Allow one redial to distinguish an access-point flap from a dead LAN without holding the recovery mutex for the full bound.
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
      // Extend once on handshake progress; connection also waits for capabilities, while a dead handshake must still time out promptly.
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
  openDirect: () => RpcClient,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RpcClient | null> {
  if (signal?.aborted) {
    return null
  }
  let client: RpcClient
  try {
    client = openDirect()
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
  return client
}
