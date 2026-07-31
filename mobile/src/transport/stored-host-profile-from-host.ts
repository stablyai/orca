import type { HostProfile, StoredHostProfile } from './types'

export function storedHostProfileFromHost(host: HostProfile): StoredHostProfile {
  const orderedDirectEndpoints =
    host.routeOrder === 1
      ? [
          ...new Set([
            host.endpoint,
            ...(host.endpoints?.filter(({ kind }) => kind !== 'relay').map(({ url }) => url) ?? [])
          ])
        ]
      : undefined
  return {
    id: host.id,
    name: host.name,
    endpoint: host.endpoint,
    ...(orderedDirectEndpoints ? { routeOrder: 1 as const, orderedDirectEndpoints } : {}),
    ...(host.lastGoodEndpoint ? { lastGoodEndpoint: host.lastGoodEndpoint } : {}),
    publicKeyB64: host.publicKeyB64,
    lastConnected: host.lastConnected
  }
}
