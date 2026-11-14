import { RELAY_DEFAULT_REGION, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import { EDGE_CONTROL_DEFAULTS, edgeFrontDoorFor } from './edge-relay-control.js'
import type { EdgeRelayConfig, EdgeRoute } from './edge-relay.js'

// The front-door route of a host's own ask, or undefined without ORCA_RELAY_EDGE_FRONT_DOOR_URLS
// (moveToEdge then runs exactly as before front doors existed). Switchable only on a real
// reconnect: `reconnect: true` without `regionCorrection` (see EdgeRoute).
export function edgeRoute(
  config: EdgeRelayConfig,
  relayHostId: string,
  requestedRegion: RelayRegion | undefined,
  country: string | null,
  ask: { reconnect?: boolean; regionCorrection?: unknown }
): EdgeRoute | undefined {
  if (config.frontDoorUrls === undefined) { return undefined }
  const door = edgeFrontDoorFor(
    config.control?.() ?? EDGE_CONTROL_DEFAULTS,
    config.frontDoorUrls,
    relayHostId,
    requestedRegion ?? RELAY_DEFAULT_REGION,
    country
  )
  return {
    ...(door === undefined ? {} : { frontDoor: door.url, byCountry: door.byCountry }),
    switchable: ask.reconnect === true && ask.regionCorrection === undefined
  }
}
