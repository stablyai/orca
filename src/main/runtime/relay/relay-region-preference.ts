import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import { readFetchResponseJsonWithinLimit } from '../../../shared/fetch-response-body'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../../shared/secure-file'

export const RELAY_REGIONS = ['us-central1', 'asia-east2'] as const
export type RelayRegion = (typeof RELAY_REGIONS)[number]

const RELAY_REGION_CACHE_FILENAME = 'orca-relay-region-preference.json'
const CACHE_MAX_BYTES = 8 * 1024
const CATALOG_MAX_BYTES = 16 * 1024
const CACHE_TTL_MS = 24 * 60 * 60_000
const PROBE_SAMPLES = 3
const PROBE_TIMEOUT_MS = 1_500
const SWITCH_MINIMUM_MS = 25
const SWITCH_RATIO = 0.8

const RelayRegionSchema = z.enum(RELAY_REGIONS)
const RelayProbeOriginSchema = z.string().max(2_048).refine(isCanonicalHttpsOrigin)
const RelayRegionCatalogSchema = z
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

const RelayRegionCacheSchema = z
  .object({
    v: z.literal(1),
    directorUrl: z.string().max(2_048),
    region: RelayRegionSchema,
    latencyMs: z.number().finite().nonnegative().max(60_000),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

type RelayRegionCatalog = z.infer<typeof RelayRegionCatalogSchema>
type RelayRegionCache = z.infer<typeof RelayRegionCacheSchema>
type RegionMeasurement = { region: RelayRegion; latencyMs: number }

type RelayRegionPreferenceOptions = {
  directorUrl: string
  userDataPath: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  measureNow?: () => number
  diagnosticOverride?: string
  probe?: (origin: string) => Promise<number | null>
  requestTimeoutMs?: number
}

export class RelayRegionPreferenceResolver {
  private readonly options: RelayRegionPreferenceOptions
  private pending: Promise<RelayRegion | undefined> | null = null

  constructor(options: RelayRegionPreferenceOptions) {
    this.options = options
  }

  async resolve(): Promise<RelayRegion | undefined> {
    const override = RelayRegionSchema.safeParse(
      this.options.diagnosticOverride ?? process.env.ORCA_RELAY_REGION_OVERRIDE
    )
    if (override.success) {
      return override.data
    }

    const now = (this.options.now ?? Date.now)()
    const cache = readRelayRegionCache(this.options.userDataPath, this.options.directorUrl, now)
    if (cache && cache.expiresAt > now) {
      return cache.region
    }
    if (this.pending) {
      return await this.pending
    }

    this.pending = this.refresh(cache, now).catch(() => undefined)
    try {
      return await this.pending
    } finally {
      this.pending = null
    }
  }

  private async refresh(
    previous: RelayRegionCache | null,
    now: number
  ): Promise<RelayRegion | undefined> {
    const fetch = this.options.fetch ?? globalThis.fetch
    const catalog = await fetchRelayRegionCatalog(
      this.options.directorUrl,
      fetch,
      this.options.requestTimeoutMs ?? PROBE_TIMEOUT_MS
    )
    const probe =
      this.options.probe ??
      ((origin: string) =>
        probeRelayOrigin(
          origin,
          fetch,
          this.options.measureNow ?? (() => performance.now()),
          this.options.requestTimeoutMs ?? PROBE_TIMEOUT_MS
        ))
    const measurements = (
      await Promise.all(catalog.regions.map((entry) => measureRegion(entry, probe)))
    ).filter((measurement): measurement is RegionMeasurement => measurement !== null)
    const selected = selectRegionMeasurement(measurements, previous)
    if (!selected) {
      return undefined
    }

    try {
      writeSecureJsonFile(join(this.options.userDataPath, RELAY_REGION_CACHE_FILENAME), {
        v: 1,
        directorUrl: this.options.directorUrl,
        region: selected.region,
        latencyMs: selected.latencyMs,
        expiresAt: now + CACHE_TTL_MS
      } satisfies RelayRegionCache)
    } catch {
      // A cache write must not block an otherwise valid Relay assignment.
    }
    return selected.region
  }
}

export function createRelayRegionPreferenceReader(input: {
  authConfig: { relayDirectorUrl: string }
  userDataPath: string
}): () => Promise<RelayRegion | undefined> {
  const resolver = new RelayRegionPreferenceResolver({
    directorUrl: input.authConfig.relayDirectorUrl,
    userDataPath: input.userDataPath
  })
  return () => resolver.resolve()
}

async function fetchRelayRegionCatalog(
  directorUrl: string,
  fetch: typeof globalThis.fetch,
  timeoutMs: number
): Promise<RelayRegionCatalog> {
  if (!isCanonicalDirectorOrigin(directorUrl)) {
    throw new Error('invalid relay director origin')
  }
  const response = await fetch(`${directorUrl}/v1/regions`, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    throw new Error(`relay region catalog failed (${response.status})`)
  }
  const body = await readFetchResponseJsonWithinLimit<unknown>(response, CATALOG_MAX_BYTES, {
    structuralTokens: 64,
    nestingDepth: 8
  })
  const catalog = RelayRegionCatalogSchema.parse(body)
  if (
    catalog.regions.some((entry) =>
      entry.probeOrigins.some((origin) => !isProbeOriginForDirector(origin, directorUrl))
    )
  ) {
    throw new Error('relay probe origin does not belong to the director')
  }
  return catalog
}

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

async function measureRegion(
  entry: RelayRegionCatalog['regions'][number],
  probe: (origin: string) => Promise<number | null>
): Promise<RegionMeasurement | null> {
  const samples: number[] = []
  for (let sample = 0; sample < PROBE_SAMPLES; sample++) {
    const latencies = (await Promise.all(entry.probeOrigins.map(probe))).filter(
      (latency): latency is number => latency !== null
    )
    if (latencies.length === 0) {
      return null
    }
    samples.push(Math.min(...latencies))
  }
  samples.sort((left, right) => left - right)
  const median = samples[1]!
  const spread = samples[2]! - samples[0]!
  if (spread > Math.max(20, median * 0.5)) {
    return null
  }
  return { region: entry.region, latencyMs: median }
}

function selectRegionMeasurement(
  measurements: RegionMeasurement[],
  previous: RelayRegionCache | null
): RegionMeasurement | null {
  const order = new Map(RELAY_REGIONS.map((region, index) => [region, index]))
  const sorted = [...measurements].sort(
    (left, right) =>
      left.latencyMs - right.latencyMs || order.get(left.region)! - order.get(right.region)!
  )
  const best = sorted[0]
  if (!best || !previous || best.region === previous.region) {
    return best ?? null
  }
  const current = measurements.find((measurement) => measurement.region === previous.region)
  if (!current) {
    return best
  }
  const meaningful =
    current.latencyMs - best.latencyMs >= SWITCH_MINIMUM_MS &&
    best.latencyMs <= current.latencyMs * SWITCH_RATIO
  return meaningful ? best : current
}

function readRelayRegionCache(userDataPath: string, directorUrl: string, now: number) {
  const path = join(userDataPath, RELAY_REGION_CACHE_FILENAME)
  try {
    if (!existsSync(path)) {
      return null
    }
    hardenExistingSecureFile(path)
    if (statSync(path).size > CACHE_MAX_BYTES) {
      return null
    }
    const parsed = RelayRegionCacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success &&
      parsed.data.directorUrl === directorUrl &&
      parsed.data.expiresAt <= now + CACHE_TTL_MS
      ? parsed.data
      : null
  } catch {
    return null
  }
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}

function isCanonicalDirectorOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    return (
      url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    )
  } catch {
    return false
  }
}

function isProbeOriginForDirector(origin: string, directorUrl: string): boolean {
  return new URL(origin).hostname.endsWith(`.${new URL(directorUrl).hostname}`)
}
