// Where sandboxes run. New sandboxes default to pdx1; iad1 is the fallback. A snapshot (golden
// image, environment build, a sandbox's own) only boots in the region it was taken in, so:
// - every region here keeps its own active golden image (golden-images.ts rotates each one);
// - a sandbox, once created, stays in its region: resume and rebuilds never move it;
// - a new sandbox with no region pinned (no explicit request region, no environment build) falls back
//   automatically to the next region when the default's provider create fails with a capacity or
//   provider error. Automatic, not operator-driven: the create has no state yet and a person is
//   waiting on it, and a regional capacity blip is over long before anyone could flip a var.
//   VERCEL_FALLBACK_REGIONS="" turns it off.
// - a desktop create or a new environment with nothing pinned starts in the served region nearest the
//   caller (Cloudflare's request geolocation), not always the default: every frame of a remote session
//   pays the round trip. Served = the default and its fallbacks that have an active golden (and so a
//   warm pool, pool.ts). The environment records its region, so its builds and workspaces stay there.
//   VERCEL_NEAREST_REGION=off turns it off.
import { ProviderError } from './sandbox-provider'

export const DEFAULT_REGION = 'pdx1'
export const DEFAULT_FALLBACK_REGIONS: readonly string[] = ['iad1']
/** Where GOLDEN_SNAPSHOT_ID (the seed image) lives: every image before regions existed was built in iad1. */
export const DEFAULT_SEED_REGION = 'iad1'
const REGION = /^[a-z]{3}[0-9]$/

export type RegionEnv = { VERCEL_REGION?: string; VERCEL_FALLBACK_REGIONS?: string; GOLDEN_SNAPSHOT_REGION?: string }

/** The default region first, then its fallbacks in order; deduplicated, malformed entries dropped. */
export function sandboxRegions(env: RegionEnv): string[] {
  const primary = env.VERCEL_REGION?.trim() || DEFAULT_REGION
  const fallbacks =
    env.VERCEL_FALLBACK_REGIONS === undefined ? DEFAULT_FALLBACK_REGIONS : env.VERCEL_FALLBACK_REGIONS.split(',').map((r) => r.trim())
  return [...new Set([primary, ...fallbacks].filter((region) => REGION.test(region)))]
}

export function seedRegion(env: RegionEnv): string {
  return env.GOLDEN_SNAPSHOT_REGION?.trim() || DEFAULT_SEED_REGION
}

/**
 * Worth retrying in another region: the provider is out of capacity (429), failing (5xx), or
 * unreachable. A 4xx is about the request itself and would fail the same way anywhere.
 */
export function isRegionalFailure(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.status === 429 || error.status >= 500 || /capacity|unavailable/i.test(error.code ?? '')
  }
  return error instanceof TypeError
}

/** Where each Vercel region is (approximate city coordinates). A region missing here is never "nearest". */
const REGION_SITES: Record<string, readonly [latitude: number, longitude: number]> = {
  iad1: [38.9, -77.0], // Washington, D.C.
  cle1: [41.5, -81.7], // Cleveland
  pdx1: [45.5, -122.7], // Portland
  sfo1: [37.8, -122.4], // San Francisco
  yul1: [45.5, -73.6], // Montréal
  gru1: [-23.6, -46.6], // São Paulo
  dub1: [53.3, -6.3], // Dublin
  lhr1: [51.5, -0.1], // London
  cdg1: [48.9, 2.4], // Paris
  fra1: [50.1, 8.7], // Frankfurt
  arn1: [59.3, 18.1], // Stockholm
  cpt1: [-33.9, 18.4], // Cape Town
  dxb1: [25.2, 55.3], // Dubai
  bom1: [19.1, 72.9], // Mumbai
  sin1: [1.4, 103.8], // Singapore
  hkg1: [22.3, 114.2], // Hong Kong
  icn1: [37.6, 127.0], // Seoul
  kix1: [34.7, 135.5], // Osaka
  hnd1: [35.7, 139.7], // Tokyo
  syd1: [-33.9, 151.2] // Sydney
}

/** A rough middle of each continent, for a request Cloudflare located only that far. */
const CONTINENT_SITES: Record<string, readonly [number, number]> = {
  NA: [40, -95],
  SA: [-15, -60],
  EU: [50, 10],
  AF: [5, 20],
  AS: [30, 100],
  OC: [-25, 140]
}

export type RequestGeo = { latitude?: number; longitude?: number; continent?: string }

/** Cloudflare's geolocation of the caller (`request.cf`); null outside the Workers runtime or when it has none. */
export function requestGeo(request: Request): RequestGeo | null {
  const cf = (request as { cf?: { latitude?: unknown; longitude?: unknown; continent?: unknown } }).cf
  if (!cf) {
    return null
  }
  const latitude = Number(cf.latitude)
  const longitude = Number(cf.longitude)
  const continent = typeof cf.continent === 'string' ? cf.continent : undefined
  const located = cf.latitude != null && cf.longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)
  if (!located && !continent) {
    return null
  }
  return { ...(located ? { latitude, longitude } : {}), ...(continent ? { continent } : {}) }
}

/** Great-circle distance in km. */
function distanceKm(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLon = (b[1] - a[1]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * `served` (default region first) reordered nearest-first for a caller at `geo`. Unchanged when the
 * caller can't be located; a region with no known site keeps its place after the located ones.
 */
export function regionsByDistance(geo: RequestGeo | null, served: readonly string[]): string[] {
  const at: readonly [number, number] | undefined =
    geo?.latitude !== undefined && geo.longitude !== undefined
      ? [geo.latitude, geo.longitude]
      : geo?.continent
        ? CONTINENT_SITES[geo.continent]
        : undefined
  if (!at) {
    return [...served]
  }
  const ranked = served.map((region, index) => {
    const site = REGION_SITES[region]
    return { region, index, km: site ? distanceKm(at, site) : Number.POSITIVE_INFINITY }
  })
  // Stable: equal distances (and unknown sites) keep the configured order, so the default wins ties.
  ranked.sort((a, b) => a.km - b.km || a.index - b.index)
  return ranked.map((entry) => entry.region)
}

/** False when VERCEL_NEAREST_REGION=off: new workspaces and environments start in the default region. */
export function nearestRegionEnabled(env: { VERCEL_NEAREST_REGION?: string }): boolean {
  return env.VERCEL_NEAREST_REGION?.trim() !== 'off'
}

/**
 * The served regions (default first) nearest-first for this request, or undefined (the default region
 * decides) when the caller can't be located, there is nothing to choose, or the choice is turned off.
 */
export function nearestRegions(request: Request, served: readonly string[], enabled = true): string[] | undefined {
  if (!enabled || served.length < 2) {
    return undefined
  }
  const geo = requestGeo(request)
  return geo ? regionsByDistance(geo, served) : undefined
}

/** The regions new sandboxes may use, default first: each has an active golden image. */
export function servedRegions(config: { defaultRegion: string; fallbackRegions?: readonly string[] }): string[] {
  return [...new Set([config.defaultRegion, ...(config.fallbackRegions ?? [])])]
}
