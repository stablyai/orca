import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import {
  fetchRelayRegionCatalog,
  isCanonicalRelayProbeOrigin,
  parseRelayRegion,
  RELAY_REGIONS,
  type RelayRegion,
  type RelayRegionCatalog
} from './relay-region-catalog'

export { RELAY_REGIONS, type RelayRegion } from './relay-region-catalog'

const RELAY_REGION_CACHE_FILENAME = 'orca-relay-region-preference.json'
const CACHE_MAX_BYTES = 8 * 1024
const CACHE_TTL_MS = 24 * 60 * 60_000
const FAILURE_RETRY_MS = 2 * 60_000
const PROBE_SAMPLES = 3
const PROBE_TIMEOUT_MS = 1_500
const SWITCH_MINIMUM_MS = 25
const SWITCH_RATIO = 0.8

const RelayRegionSchema = z.enum(RELAY_REGIONS)

const RelayRegionCacheSchema = z
  .object({
    v: z.literal(1),
    directorUrl: z.string().max(2_048),
    region: RelayRegionSchema,
    latencyMs: z.number().finite().nonnegative().max(60_000),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

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
  private retryAfter = 0
  private failureLogged = false

  constructor(options: RelayRegionPreferenceOptions) {
    this.options = options
  }

  async resolve(): Promise<RelayRegion | undefined> {
    const override = parseRelayRegion(
      this.options.diagnosticOverride ?? process.env.ORCA_RELAY_REGION_OVERRIDE
    )
    if (override) {
      return override
    }

    const now = (this.options.now ?? Date.now)()
    const cache = readRelayRegionCache(this.options.userDataPath, this.options.directorUrl, now)
    if (cache && cache.expiresAt > now) {
      return cache.region
    }
    if (now < this.retryAfter) {
      return undefined
    }
    if (this.pending) {
      return await this.pending
    }

    this.pending = this.refresh(cache, now).then(
      (region) => {
        this.retryAfter = 0
        this.failureLogged = false
        return region
      },
      (error) => {
        this.retryAfter = (this.options.now ?? Date.now)() + FAILURE_RETRY_MS
        const reason = relayRegionFailureReason(error)
        if (!this.failureLogged && reason !== 'catalog-http-404') {
          console.warn('[relay] region preference unavailable:', reason)
          this.failureLogged = true
        }
        return undefined
      }
    )
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
      throw new Error('relay region probes unavailable')
    }

    try {
      writeRelayRegionCache(join(this.options.userDataPath, RELAY_REGION_CACHE_FILENAME), {
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

export async function probeRelayOrigin(
  origin: string,
  fetch: typeof globalThis.fetch,
  now = () => performance.now(),
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<number | null> {
  if (!isCanonicalRelayProbeOrigin(origin)) {
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

function writeRelayRegionCache(path: string, cache: RelayRegionCache): void {
  // This cache is non-secret; avoid synchronous Windows ACL subprocesses on the main thread.
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function relayRegionFailureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'request-failed'
  }
  if (error.message === 'relay region probes unavailable') {
    return 'probes-unavailable'
  }
  if (
    error.message === 'invalid relay director origin' ||
    error.message === 'invalid relay region catalog' ||
    error.message === 'invalid relay region entry' ||
    error.message === 'duplicate relay region' ||
    error.message === 'invalid relay probe origin' ||
    error.message === 'duplicate relay probe origin'
  ) {
    return 'invalid-catalog'
  }
  const status = /^relay region catalog failed \(([1-5]\d\d)\)$/.exec(error.message)?.[1]
  return status ? `catalog-http-${status}` : 'request-failed'
}
