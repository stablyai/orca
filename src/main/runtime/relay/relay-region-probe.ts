import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

export const RELAY_REGIONS = ['us-central1', 'asia-east2'] as const
export type RelayRegion = (typeof RELAY_REGIONS)[number]

export const PROBE_TIMEOUT_MS = 1_500
const PROBE_SAMPLES = 3
// Absolute floor for the flap check: a warmed keep-alive path still jitters, and
// a floor below TLS-scale noise rejects healthy regions on nearly every run.
const SPREAD_FLOOR_MS = 150

export const RelayRegionSchema = z.enum(RELAY_REGIONS)
export const RelayProbeOriginSchema = z.string().max(2_048).refine(isCanonicalHttpsOrigin)
export const RelayRegionCatalogSchema = z
  .object({
    v: z.literal(1),
    regions: z
      .array(
        z
          .object({
            region: RelayRegionSchema,
            probeOrigins: z.array(RelayProbeOriginSchema).min(1).max(2)
          })
          .strict()
      )
      .max(RELAY_REGIONS.length)
  })
  .strict()
  .superRefine((catalog, context) => {
    const regions = new Set<RelayRegion>()
    const origins = new Set<string>()
    for (const [regionIndex, entry] of catalog.regions.entries()) {
      if (regions.has(entry.region)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate relay region',
          path: ['regions', regionIndex, 'region']
        })
      }
      regions.add(entry.region)
      for (const [originIndex, origin] of entry.probeOrigins.entries()) {
        if (origins.has(origin)) {
          context.addIssue({
            code: 'custom',
            message: 'duplicate relay probe origin',
            path: ['regions', regionIndex, 'probeOrigins', originIndex]
          })
        }
        origins.add(origin)
      }
    }
  })

export type RelayRegionCatalog = z.infer<typeof RelayRegionCatalogSchema>
export type RelayRegionCatalogEntry = RelayRegionCatalog['regions'][number]
export type RegionMeasurement = { region: RelayRegion; latencyMs: number }
export type RelayProbe = (origin: string) => Promise<number | null>

export async function probeRelayOrigin(
  origin: string,
  fetch: typeof globalThis.fetch,
  now = () => performance.now(),
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<number | null> {
  if (!RelayProbeOriginSchema.safeParse(origin).success) {
    return null
  }
  const startedAt = now()
  try {
    const response = await fetch(`${origin}/health`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const latencyMs = now() - startedAt
    await cancelUnreadResponseBody(response)
    return response.ok && Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null
  } catch {
    return null
  }
}

type LatencySamples = {
  /** Discarded first round per origin; it pays TCP and TLS setup. */
  warmupMs: (number | null)[]
  /** Ascending per-round minimums across the live origins; empty means unreachable. */
  keptMs: number[]
}

export type RelayRegionProbeVerdict = 'measured' | 'rejected-spread' | 'unreachable'

export type RelayRegionProbeReport = {
  region: RelayRegion
  origins: string[]
  warmupMs: (number | null)[]
  keptMs: number[]
  minMs: number | null
  spreadMs: number | null
  verdict: RelayRegionProbeVerdict
}

// The first request of a process pays TCP and TLS setup, which can exceed the
// round trip it is meant to measure, so it is discarded before sampling.
async function sampleMinLatencies(origins: string[], probe: RelayProbe): Promise<LatencySamples> {
  const warmupMs = await Promise.all(origins.map(probe))
  // An origin that failed its warm-up would spend one probe timeout per round
  // to report nothing, so the sampling rounds skip it entirely.
  const live = origins.filter((_origin, index) => warmupMs[index] !== null)
  if (live.length === 0) {
    return { warmupMs, keptMs: [] }
  }
  const keptMs: number[] = []
  for (let sample = 0; sample < PROBE_SAMPLES; sample++) {
    const latencies = (await Promise.all(live.map(probe))).filter(
      (latency): latency is number => latency !== null
    )
    if (latencies.length === 0) {
      return { warmupMs, keptMs: [] }
    }
    keptMs.push(Math.min(...latencies))
  }
  keptMs.sort((left, right) => left - right)
  return { warmupMs, keptMs }
}

export async function measureOriginLatency(
  origin: string,
  probe: RelayProbe
): Promise<number | null> {
  return (await sampleMinLatencies([origin], probe)).keptMs[0] ?? null
}

export async function measureRegion(
  entry: RelayRegionCatalogEntry,
  probe: RelayProbe
): Promise<RelayRegionProbeReport> {
  const { warmupMs, keptMs } = await sampleMinLatencies(entry.probeOrigins, probe)
  const probed = { region: entry.region, origins: entry.probeOrigins, warmupMs, keptMs }
  if (keptMs.length === 0) {
    return { ...probed, minMs: null, spreadMs: null, verdict: 'unreachable' }
  }
  const [min, median, max] = keptMs as [number, number, number]
  const spreadMs = max - min
  // Regions compare by their best round trip; the spread check only rejects a
  // path that is genuinely flapping, not one that warmed up.
  const verdict = spreadMs > Math.max(SPREAD_FLOOR_MS, median) ? 'rejected-spread' : 'measured'
  return { ...probed, minMs: min, spreadMs, verdict }
}

export function regionMeasurement(report: RelayRegionProbeReport): RegionMeasurement | null {
  return report.verdict === 'measured' && report.minMs !== null
    ? { region: report.region, latencyMs: report.minMs }
    : null
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}
