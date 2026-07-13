import { normalizePairingEndpoints, type PairingOffer } from './types'
import type { HostProfile, MobileAccessEndpoint } from './types'

function classifyEndpointKind(url: string): MobileAccessEndpoint['kind'] {
  try {
    const hostname = new URL(url).hostname
    if (hostname.endsWith('.ts.net') || /^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname)) {
      return 'tailscale'
    }
  } catch {}
  return 'lan'
}

function pairingEndpointsToMobileAccessEndpoints(urls: string[]): MobileAccessEndpoint[] {
  return urls.map((url, index) => ({
    id: index === 0 ? 'direct-primary' : `direct-${index}`,
    kind: classifyEndpointKind(url),
    url
  }))
}

/** Build a host profile from a successful pairing offer (no last-good yet). */
export function hostProfileFromPairingOffer(args: {
  id: string
  name: string
  offer: PairingOffer
  lastConnected?: number
}): HostProfile {
  const urls = normalizePairingEndpoints(args.offer.endpoint, args.offer.endpoints)
  const endpoints = pairingEndpointsToMobileAccessEndpoints(urls)
  return {
    id: args.id,
    name: args.name,
    endpoint: urls[0]!,
    endpoints,
    deviceToken: args.offer.deviceToken,
    publicKeyB64: args.offer.publicKeyB64,
    lastConnected: args.lastConnected ?? Date.now()
  }
}
