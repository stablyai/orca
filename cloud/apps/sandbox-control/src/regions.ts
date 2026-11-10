// Where sandboxes run (U17). New sandboxes default to pdx1; iad1 is the fallback. A snapshot (golden
// image, environment build, a sandbox's own) only boots in the region it was taken in, so:
// - every region here keeps its own active golden image (golden-images.ts rotates each one);
// - a sandbox, once created, stays in its region: resume and rebuilds never move it;
// - a new sandbox with no region pinned (no explicit request region, no environment build) falls back
//   automatically to the next region when the default's provider create fails with a capacity or
//   provider error. Automatic, not operator-driven: the create has no state yet and a person is
//   waiting on it, and a regional capacity blip is over long before anyone could flip a var.
//   VERCEL_FALLBACK_REGIONS="" turns it off.
import { ProviderError } from './sandbox-provider'

export const DEFAULT_REGION = 'pdx1'
export const DEFAULT_FALLBACK_REGIONS: readonly string[] = ['iad1']
/** Where GOLDEN_SNAPSHOT_ID (the seed image) lives: every image before U17 was built in iad1. */
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
