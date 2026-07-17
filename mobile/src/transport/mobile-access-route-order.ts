import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { normalizePairingEndpoints, type HostProfile, type MobileAccessEndpoint } from './types'

export function classifyDirectEndpointKind(url: string): MobileAccessEndpoint['kind'] {
  try {
    const hostname = new URL(url).hostname
    if (hostname.endsWith('.ts.net') || /^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname)) {
      return 'tailscale'
    }
  } catch {}
  return 'lan'
}

export function relayWebSocketUrl(relay: MobileRelayEndpoint): string {
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
}

export function buildMobileAccessRoutes(args: {
  directUrls: readonly string[]
  relay?: MobileRelayEndpoint | null
  relayPreferenceIndex?: number
}): MobileAccessEndpoint[] {
  const direct = args.directUrls.map((url, index) => ({
    id: index === 0 ? 'direct-primary' : `direct-${index}`,
    kind: classifyDirectEndpointKind(url),
    url
  }))
  if (!args.relay) {
    return direct
  }
  const relayIndex = Math.max(
    0,
    Math.min(direct.length, args.relayPreferenceIndex ?? direct.length)
  )
  const routes: MobileAccessEndpoint[] = [...direct]
  routes.splice(relayIndex, 0, {
    id: 'relay-primary',
    kind: 'relay',
    url: relayWebSocketUrl(args.relay)
  })
  return routes
}

export function orderedHostAccessRoutes(host: HostProfile): MobileAccessEndpoint[] {
  const configured = host.endpoints?.length
    ? host.endpoints
    : buildMobileAccessRoutes({
        directUrls: normalizePairingEndpoints(host.endpoint),
        relay: host.relay
      })
  const seen = new Set<string>()
  const routes = configured.filter(({ url }) => {
    if (seen.has(url)) {
      return false
    }
    seen.add(url)
    return true
  })
  const lastGood = host.lastGoodEndpoint?.trim()
  const stickyIndex = lastGood ? routes.findIndex(({ url }) => url === lastGood) : -1
  if (stickyIndex <= 0) {
    return routes
  }
  // Why: last-good is a session hint, not a rewrite of the user's durable order.
  return [routes[stickyIndex]!, ...routes.slice(0, stickyIndex), ...routes.slice(stickyIndex + 1)]
}
