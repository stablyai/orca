import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { DirectCandidate } from '../relay/mobile-preferred-direct-candidate'

export function mobileDirectReturnCandidates(
  deps: MobileEndpointSupervisorDependencies,
  activePath: MobileConnectionPath,
  tailnetEndpoint: string | undefined
): DirectCandidate[] {
  const primary: DirectCandidate = {
    path: deps.directPath,
    open: deps.openDirect,
    timeoutMs: deps.directProbeTimeoutMs
  }
  if (activePath === 'tailscale') {
    // When Tailscale is healthy, only consider promoting the LAN route.
    return !deps.directUnavailable && deps.directPath === 'lan' ? [primary] : []
  }
  if (activePath !== 'relay') {
    return []
  }
  const candidates = deps.directUnavailable ? [] : [primary]
  if (tailnetEndpoint && deps.openTailnetDirect && deps.directPath !== 'tailscale') {
    candidates.push({
      path: 'tailscale',
      open: () => deps.openTailnetDirect!(tailnetEndpoint),
      timeoutMs: 12_000
    })
  }
  return candidates
}
