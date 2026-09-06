import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

function directEndpointUrls(host: HostProfile): string[] {
  const endpoints =
    host.endpoints?.filter(({ kind }) => kind !== 'relay').map(({ url }) => url) ?? []
  return [...new Set([host.endpoint, ...endpoints])]
}

export function directPathForEndpoint(
  host: HostProfile,
  endpoint: string
): Exclude<MobileConnectionPath, 'relay'> {
  const configured = host.endpoints?.find((candidate) => candidate.url === endpoint)
  if (configured?.kind === 'tailscale') {
    return 'tailscale'
  }
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

function waitForAuthenticatedSession(session: RpcClient, timeoutMs: number): Promise<void> {
  if (session.getState() === 'connected') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = session.onStateChange((state) => {
      if (state === 'connected') {
        finish()
        resolve()
        return
      }
      if (state === 'reconnecting' && !graceTimer) {
        graceTimer = setTimeout(() => {
          finish()
          reject(new Error('probe session reconnecting'))
        }, RECONNECT_GRACE_MS)
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
    function finish(): void {
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
  timeoutMs: number
): Promise<{ client: RpcClient; path: Exclude<MobileConnectionPath, 'relay'> } | null> {
  const endpoints = directEndpointUrls(host)
  return await new Promise((resolve) => {
    const clients = new Set<RpcClient>()
    let remaining = endpoints.length
    let settled = false
    const rejectCandidate = (): void => {
      remaining--
      if (!settled && remaining === 0) {
        settled = true
        resolve(null)
      }
    }
    for (const endpoint of endpoints) {
      let client: RpcClient
      try {
        client = openDirect(endpoint)
      } catch {
        rejectCandidate()
        continue
      }
      clients.add(client)
      void waitForAuthenticatedSession(client, timeoutMs).then(
        () => {
          if (settled) {
            client.close()
            return
          }
          settled = true
          for (const candidate of clients) {
            if (candidate !== client) {
              candidate.close()
            }
          }
          resolve({ client, path: directPathForEndpoint(host, endpoint) })
        },
        () => {
          if (settled) {
            return
          }
          client.close()
          rejectCandidate()
        }
      )
    }
  })
}
