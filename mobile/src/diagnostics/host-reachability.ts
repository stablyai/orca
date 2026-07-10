import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'

const HOST_REACHABILITY_TIMEOUT_MS = 4000

// Why: troubleshooting needs a cheap endpoint probe without completing the
// encrypted mobile runtime handshake.
export async function testHostReachability(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(endpoint)
    } catch {
      resolve(false)
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (reachable: boolean, closeSocket: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (closeSocket) {
        try {
          ws.close()
        } catch {
          // The probe is already complete; close failures should not change the diagnostic result.
        }
      }
      resolve(reachable)
    }

    timeout = setTimeout(() => {
      finish(false, true)
    }, HOST_REACHABILITY_TIMEOUT_MS)

    ws.onopen = () => {
      finish(true, true)
    }

    ws.onerror = () => {
      finish(false, true)
    }
  })
}

export function formatEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return url.host
  } catch {
    return endpoint
  }
}

// Why: an unreachable 100.x/*.ts.net host almost always means the phone's
// Tailscale tunnel is down or wedged (known iOS failure mode, fixed by
// toggling the VPN) — point at that instead of a bare "Cannot reach".
export function unreachableHostDetail(endpoint: string): string {
  if (isTailscaleEndpoint(endpoint)) {
    return `Cannot reach ${formatEndpoint(endpoint)} — check Tailscale`
  }
  return `Cannot reach ${formatEndpoint(endpoint)}`
}
