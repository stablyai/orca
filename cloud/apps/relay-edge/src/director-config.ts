// Edge-native director (dark; docs/relay-edge/research/director-removal.md §3, step 1): the
// Worker answers the director's client-facing endpoints from the host's own object, but only for
// requests whose dialled hostname is DIRECTOR_HOSTNAME. Unset (every environment today): null, and
// the Worker routes exactly as it does without this file.
//   DIRECTOR_HOSTNAME              the director hostname this Worker answers for (e.g. a test host)
//   DIRECTOR_EDGE_URL              the edge's public origin handed to hosts and phones
//   DIRECTOR_FRONT_DOOR_URL        optional: the front door origin for the countries below
//   DIRECTOR_FRONT_DOOR_COUNTRIES  optional, comma-separated ISO codes (default 'CN')
// A set but malformed setup leaves the endpoints off and reports why (never thrown).
import { RELAY_REGIONS, type RelayRegion } from '../../../packages/relay-contract/src/relay-regions'
import type { Env } from './env'
import { metric } from './metrics'

export type DirectorConfig = {
  hostname: string
  edgeUrl: string
  frontDoorUrl: string | null
  frontDoorCountries: readonly string[]
}

// What the client dialled: a trusted ingress hop's origin, else the Worker's own URL.
export function dialledHostname(request: Request, ingress: { origin: string } | null): string {
  return new URL(ingress?.origin ?? request.url).hostname.toLowerCase()
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const COUNTRY = /^[A-Z]{2}$/
const configs = new WeakMap<object, DirectorConfig | null>()

function canonicalHttpsOrigin(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) { return null }
  const url = new URL(value)
  return url.protocol === 'https:' && url.origin === value ? value : null
}

export function parseDirectorConfig(env: Pick<Env, 'DIRECTOR_HOSTNAME' | 'DIRECTOR_EDGE_URL' | 'DIRECTOR_FRONT_DOOR_URL' | 'DIRECTOR_FRONT_DOOR_COUNTRIES'>): { config: DirectorConfig | null; problems: string[] } {
  const hostname = env.DIRECTOR_HOSTNAME?.trim().toLowerCase() ?? ''
  if (!hostname) { return { config: null, problems: [] } }
  const edgeUrl = canonicalHttpsOrigin(env.DIRECTOR_EDGE_URL?.trim())
  const frontDoorRaw = env.DIRECTOR_FRONT_DOOR_URL?.trim()
  const frontDoorUrl = frontDoorRaw ? canonicalHttpsOrigin(frontDoorRaw) : null
  const countries = (env.DIRECTOR_FRONT_DOOR_COUNTRIES ?? 'CN').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  const problems = [
    HOSTNAME.test(hostname) ? '' : 'hostname_invalid',
    edgeUrl ? '' : 'edge_url_invalid',
    frontDoorRaw && !frontDoorUrl ? 'front_door_url_invalid' : '',
    countries.every((c) => COUNTRY.test(c)) ? '' : 'countries_invalid',
    // Handing out the director's own hostname as a cell would loop the client back here.
    [edgeUrl, frontDoorUrl].some((u) => u !== null && new URL(u).hostname === hostname) ? 'cell_url_is_director' : ''
  ].filter(Boolean)
  if (problems.length > 0 || !edgeUrl) { return { config: null, problems } }
  return { config: { hostname, edgeUrl, frontDoorUrl, frontDoorCountries: countries }, problems: [] }
}

// Validated once per isolate, like edgeConfig.
export function directorConfig(env: Env): DirectorConfig | null {
  if (!env.DIRECTOR_HOSTNAME) { return null }
  const cached = configs.get(env)
  if (cached !== undefined) { return cached }
  const { config, problems } = parseDirectorConfig(env)
  configs.set(env, config)
  if (problems.length > 0) {
    console.error(JSON.stringify({ event: 'relay_edge_director_config_invalid', problems }))
    for (const problem of problems) { metric(env, 'director', 1, `config:${problem}`) }
  }
  return config
}

// Country routing (§3): the front door for its countries, else the edge. The country is the
// trusted ingress hop's client country, else the platform's (request.cf) for a direct request.
export function directorCellUrl(config: DirectorConfig, country: string | undefined): string {
  if (config.frontDoorUrl && country && config.frontDoorCountries.includes(country.toUpperCase())) { return config.frontDoorUrl }
  return config.edgeUrl
}

// GET /v1/regions: a static catalog. Shipped desktops require every probe origin to be a subdomain
// of the director host; each probe host must reach this Worker (its /health) to measure anything.
// An unreachable probe only makes the desktop's region choice inconclusive (no preferredRegion).
export const DIRECTOR_PROBE_PREFIXES = { 'us-central1': 'us.probe', 'asia-east2': 'asia.probe' } as const satisfies Record<RelayRegion, string>

export function directorRegionCatalog(hostname: string): { v: 1; regions: { region: RelayRegion; probeOrigins: string[] }[] } {
  return { v: 1, regions: RELAY_REGIONS.map((region) => ({ region, probeOrigins: [`https://${DIRECTOR_PROBE_PREFIXES[region]}.${hostname}`] })) }
}

// A desktop's preferred region becomes the object's location hint, used only when the host's
// object is first created (objects never move).
export const REGION_LOCATION_HINT = { 'us-central1': 'enam', 'asia-east2': 'apac' } as const satisfies Record<RelayRegion, DurableObjectLocationHint>
