import {
  PairingGetDirectEndpointsResultSchema,
  type PairingGetDirectEndpointsResult
} from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileAccessEndpoint } from './mobile-relay-host-overlay'
import type { RpcClient } from './rpc-client'
import type { HostProfile } from './types'

const OVERLAY_ENDPOINT_MAX = 16

export function mergeAdvertisedDirectEndpoints(
  host: HostProfile,
  advertised: PairingGetDirectEndpointsResult
): HostProfile {
  if (!advertised.selected && advertised.endpoints.length === 0) {
    return host
  }
  const selectedUrl = advertised.selected?.url ?? advertised.endpoints[0]?.url
  if (!selectedUrl) {
    return host
  }
  const seen = new Set<string>()
  const direct: MobileAccessEndpoint[] = []
  for (const endpoint of [advertised.selected, ...advertised.endpoints]) {
    if (!endpoint || seen.has(endpoint.url)) {
      continue
    }
    seen.add(endpoint.url)
    direct.push({
      id: endpoint.url === selectedUrl ? 'direct-primary' : `direct-${direct.length + 1}`,
      kind: endpoint.kind,
      url: endpoint.url
    })
  }
  const relay = (host.endpoints ?? []).filter(({ kind }) => kind === 'relay')
  const endpoints = [
    ...direct.slice(0, Math.max(0, OVERLAY_ENDPOINT_MAX - relay.length)),
    ...relay
  ]
  if (endpoints.length === 0) {
    return { ...host, endpoint: selectedUrl, endpoints: undefined }
  }
  return { ...host, endpoint: selectedUrl, endpoints }
}

export async function refreshHostDirectEndpoints(args: {
  client: RpcClient
  host: HostProfile
  saveHost: (host: HostProfile) => Promise<void>
  unsupported?: { current: boolean }
}): Promise<HostProfile> {
  if (args.unsupported?.current) {
    return args.host
  }
  try {
    const response = await args.client.sendRequest('pairing.getDirectEndpoints', {})
    if (!response.ok) {
      if (response.error.code === 'method_not_found' && args.unsupported) {
        args.unsupported.current = true
      }
      return args.host
    }
    const advertised = PairingGetDirectEndpointsResultSchema.parse(response.result)
    const next = mergeAdvertisedDirectEndpoints(args.host, advertised)
    if (next === args.host || hostDirectStateEqual(args.host, next)) {
      return args.host
    }
    await args.saveHost(next)
    return next
  } catch {
    return args.host
  }
}

function hostDirectStateEqual(left: HostProfile, right: HostProfile): boolean {
  return (
    left.endpoint === right.endpoint &&
    JSON.stringify(left.endpoints ?? null) === JSON.stringify(right.endpoints ?? null)
  )
}

export class HostDirectEndpointRefresh {
  private readonly unsupported = { current: false }

  constructor(private readonly saveHost: (host: HostProfile) => Promise<void>) {}

  apply(client: RpcClient, host: HostProfile): Promise<HostProfile> {
    return refreshHostDirectEndpoints({
      client,
      host,
      saveHost: this.saveHost,
      unsupported: this.unsupported
    })
  }
}
