import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { DirectCandidate } from '../relay/mobile-preferred-direct-candidate'

export type LearnedDirectEndpoints = {
  lanEndpoint?: string
  tailnetEndpoint?: string
}

// Prefer LAN, then Tailscale, but never try an unknown or duplicated address.
export function mobileDirectReturnCandidates(
  deps: MobileEndpointSupervisorDependencies,
  activePath: MobileConnectionPath,
  endpoints: LearnedDirectEndpoints
): DirectCandidate[] {
  const lan: DirectCandidate | null =
    endpoints.lanEndpoint && deps.openLanDirect
      ? {
          path: 'lan',
          open: () => deps.openLanDirect!(endpoints.lanEndpoint!),
          timeoutMs: 4_000
        }
      : deps.directPath === 'lan' && !deps.directUnavailable
        ? { path: 'lan', open: deps.openDirect, timeoutMs: deps.directProbeTimeoutMs }
        : null
  const tailnet: DirectCandidate | null =
    deps.directPath === 'tailscale' && !deps.directUnavailable
      ? { path: 'tailscale', open: deps.openDirect, timeoutMs: deps.directProbeTimeoutMs }
      : endpoints.tailnetEndpoint && deps.openTailnetDirect
        ? {
            path: 'tailscale',
            open: () => deps.openTailnetDirect!(endpoints.tailnetEndpoint!),
            timeoutMs: 12_000
          }
        : null

  if (activePath === 'tailscale') {
    return lan ? [lan] : []
  }
  if (activePath === 'relay') {
    return [lan, tailnet].filter((candidate): candidate is DirectCandidate => candidate !== null)
  }
  return []
}
