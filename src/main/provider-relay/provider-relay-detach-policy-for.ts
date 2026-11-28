import type { ProviderRelayDetachPolicy } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayWorkMarkers } from './provider-relay-agent-markers'
import { providerRelayRoute } from './provider-relay-route'

/** The provider's open work at detach, keyed as its markers key it. */
export type ProviderRelayOpenWork = Record<string, string[][]>

/** What the daemon's idle stop counts for a relay, with the user's current idle stop. */
export function policyFor(
  markers: ProviderRelayWorkMarkers,
  open?: ProviderRelayOpenWork | null
): ProviderRelayDetachPolicy {
  return {
    idleStopMs: providerRelayRoute()?.idleStopMs() ?? null,
    markers: [...markers.markers],
    ...(markers.requests ? { workRequests: [...markers.requests] } : {}),
    ...(markers.quiet ? { quiet: [...markers.quiet] } : {}),
    ...(markers.startApprovals ? { startApprovals: [...markers.startApprovals] } : {}),
    ...(open ? { open } : {})
  }
}
