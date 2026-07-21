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

function waitForAuthenticatedSession(session: RpcClient, timeoutMs: number): Promise<void> {
  if (session.getState() === 'connected') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = session.onStateChange((state) => {
      if (state === 'connected') {
        finish()
        resolve()
      } else if (state === 'disconnected' || state === 'auth-failed') {
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
      unsubscribe()
    }
  })
}

export async function openAuthenticatedDirectEndpoint(
  host: HostProfile,
  openDirect: (endpoint: string) => RpcClient,
  timeoutMs: number
): Promise<{ client: RpcClient; path: Exclude<MobileConnectionPath, 'relay'> } | null> {
  for (const endpoint of directEndpointUrls(host)) {
    const client = openDirect(endpoint)
    try {
      await waitForAuthenticatedSession(client, timeoutMs)
      return { client, path: directPathForEndpoint(host, endpoint) }
    } catch {
      client.close()
    }
  }
  return null
}
