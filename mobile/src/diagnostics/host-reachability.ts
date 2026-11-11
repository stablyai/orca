import { webSocketUpgradeStatus } from './connection/socket-event-debug'
import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import {
  createEndpointAuthSocket,
  edgeAuthHeadersForEndpoint,
  type EndpointAuthHeaders
} from '../transport/endpoint-auth-headers'

export type HostReachability = { reachable: true } | { reachable: false; httpStatus?: number }

const HOST_REACHABILITY_TIMEOUT_MS = 4000

// Probe reachability without completing the encrypted runtime handshake.
export async function testHostReachability(
  endpoint: string,
  endpointAuthHeaders: EndpointAuthHeaders | null = null
): Promise<HostReachability> {
  return new Promise((resolve) => {
    let ws: WebSocket
    try {
      const headers = edgeAuthHeadersForEndpoint(endpoint, endpointAuthHeaders)
      ws = headers ? createEndpointAuthSocket(endpoint, headers) : new WebSocket(endpoint)
    } catch {
      resolve({ reachable: false })
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (result: HostReachability): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      try {
        ws.close()
      } catch {
        // The probe is already complete; close failures should not change the diagnostic result.
      }
      resolve(result)
    }

    timeout = setTimeout(() => {
      finish({ reachable: false })
    }, HOST_REACHABILITY_TIMEOUT_MS)

    ws.onopen = () => {
      finish({ reachable: true })
    }

    ws.onerror = (event) => {
      const httpStatus = webSocketUpgradeStatus(event)
      finish({ reachable: false, httpStatus })
    }
  })
}

export function formatEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return url.host
  } catch {
    return 'invalid endpoint'
  }
}

// Unreachable 100.x/*.ts.net usually means a wedged Tailscale tunnel on iOS; suggest toggling the VPN.
export function unreachableHostDetail(endpoint: string): string {
  if (isTailscaleEndpoint(endpoint)) {
    return `Cannot reach ${formatEndpoint(endpoint)} — check Tailscale`
  }
  return `Cannot reach ${formatEndpoint(endpoint)}`
}
