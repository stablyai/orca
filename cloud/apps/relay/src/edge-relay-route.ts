import { RELAY_DEFAULT_REGION, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import { EDGE_CONTROL_DEFAULTS, edgeFrontDoorFor, edgeFrontDoorListsHost } from './edge-relay-control.js'
import { EDGE_CELL_ID, edgeCohortBucketPermille, type EdgeRelayConfig, type EdgeRoute } from './edge-relay.js'

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
    country,
    edgeCohortBucketPermille(relayHostId)
  )
  return {
    ...(door === undefined ? {} : { frontDoor: door.url, byCountry: door.byCountry }),
    switchable: ask.reconnect === true && ask.regionCorrection === undefined
  }
}

// AssignmentResponse.alternateCellUrls for an answer (director/edge.json alternates), or undefined
// for none. Only an edge answer has one, and only with ORCA_RELAY_EDGE_FRONT_DOOR_URLS: answered
// through an allowed front door, the edge's own URL; answered with the edge's own URL, the front
// door the flags map this ask to (as edgeRoute would). GCE cells never: their proof and placement
// are per cell. `region` and `country`: the same the ask's edgeRoute uses.
export function edgeAlternateCellUrls(
  config: EdgeRelayConfig,
  relayHostId: string,
  requestedRegion: RelayRegion | undefined,
  country: string | null,
  answered: { cellId: string; cellUrl: string }
): string[] | undefined {
  if (answered.cellId !== EDGE_CELL_ID || config.frontDoorUrls === undefined) { return undefined }
  const flags = config.control?.() ?? EDGE_CONTROL_DEFAULTS
  const mode = flags.alternates ?? 'off'
  if (mode === 'off') { return undefined }
  if (mode === 'listed' && !edgeFrontDoorListsHost(flags, config.frontDoorUrls, relayHostId)) { return undefined }
  const alternate = config.frontDoorUrls.has(answered.cellUrl)
    ? config.cellUrl
    : answered.cellUrl === config.cellUrl
      ? edgeFrontDoorFor(
          flags,
          config.frontDoorUrls,
          relayHostId,
          requestedRegion ?? RELAY_DEFAULT_REGION,
          country,
          edgeCohortBucketPermille(relayHostId)
        )?.url
      : undefined
  return alternate === undefined || alternate === answered.cellUrl ? undefined : [alternate]
}

// AssignmentResponse.authOrigin for an answer (director/edge.json frontDoorAuth), or undefined for
// none: the front door origin the answer routes through, which also proxies the desktop auth
// refresh and relay-token endpoints. Only an edge answer whose cellUrl is an allowed front door
// (ORCA_RELAY_EDGE_FRONT_DOOR_URLS) has one; a direct edge or GCE answer never does.
export function edgeAuthOrigin(config: EdgeRelayConfig, answered: { cellId: string; cellUrl: string }): string | undefined {
  if (answered.cellId !== EDGE_CELL_ID || config.frontDoorUrls === undefined) { return undefined }
  const flags = config.control?.() ?? EDGE_CONTROL_DEFAULTS
  if ((flags.frontDoorAuth ?? 'off') !== 'on') { return undefined }
  return config.frontDoorUrls.has(answered.cellUrl) ? answered.cellUrl : undefined
}
