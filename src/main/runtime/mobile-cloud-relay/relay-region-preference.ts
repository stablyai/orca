import { measureRelayRegionDecision } from './relay-region-decision'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../../shared/secure-file'
import { fetchRelayRegionCatalog, relayDirectorHost } from './relay-region-catalog-fetch'
import type { RelayRegionDecision, RelayRegionWindow } from './relay-region-correction-protocol'
import {
  logRelayRegionEvent,
  relayRegionCacheHitEvent,
  relayRegionCatalogFailureEvent,
  relayRegionOverrideEvent,
  relayRegionRefreshEvent,
  RELAY_REGION_SELF_HEAL_EVENT,
  type RelayRegionLogSink,
  type RelayRegionSelfHealLogEvent
} from './relay-region-probe-log'
import {
  measureOriginLatency,
  RELAY_REGIONS,
  measureRegion,
  probeRelayOrigin,
  PROBE_TIMEOUT_MS,
  regionMeasurement,
  RelayRegionSchema,
  type RegionMeasurement,
  type RelayProbe,
  type RelayRegion,
  type RelayRegionCatalog,
  type RelayRegionProbeReport
} from './relay-region-probe'

const RELAY_REGION_CACHE_FILENAME = 'orca-relay-region-preference.json'
const CACHE_MAX_BYTES = 8 * 1024
const CACHE_TTL_MS = 24 * 60 * 60_000
// Cache withheld hints briefly to avoid probing every reconnect without retaining them as long as chosen regions.
const NO_HINT_TTL_MS = 60 * 60_000
const SWITCH_MINIMUM_MS = 25
const SWITCH_RATIO = 0.8
const FAR_CELL_RATIO = 3

const RelayRegionCacheSchema = z
  .object({
    v: z.literal(2),
    directorUrl: z.string().max(2_048),
    region: RelayRegionSchema.nullable(),
    latencyMs: z.number().finite().nonnegative().max(60_000).optional(),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

type RelayRegionCache = z.infer<typeof RelayRegionCacheSchema>

export function clearRelayRegionPreferenceCache(userDataPath: string): void {
  rmSync(join(userDataPath, RELAY_REGION_CACHE_FILENAME), { force: true })
}

type RelayRegionPreferenceOptions = {
  directorUrl: string
  userDataPath: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  measureNow?: () => number
  diagnosticOverride?: string
  probe?: RelayProbe
  requestTimeoutMs?: number
  logEvent?: RelayRegionLogSink
}

export class RelayRegionPreferenceResolver {
  private readonly options: RelayRegionPreferenceOptions
  private pending: Promise<RelayRegion | undefined> | null = null
  private readonly selfHealedCells = new Set<string>()

  constructor(options: RelayRegionPreferenceOptions) {
    this.options = options
  }

  measureDecision(window: RelayRegionWindow): Promise<RelayRegionDecision> {
    return measureRelayRegionDecision(window, {
      diagnosticOverride: Boolean(this.overrideRegion()),
      now: this.options.now ?? Date.now,
      measure: () => this.probeCatalog(this.options.fetch ?? globalThis.fetch)
    })
  }

  async resolve(): Promise<RelayRegion | undefined> {
    const override = this.overrideRegion()
    if (override) {
      this.log(
        relayRegionOverrideEvent({ directorUrl: this.options.directorUrl, region: override })
      )
      return override
    }

    const now = (this.options.now ?? Date.now)()
    const cache = readRelayRegionCache(this.cachePath(), this.options.directorUrl, now)
    if (cache && cache.expiresAt > now) {
      this.log(
        relayRegionCacheHitEvent({
          directorUrl: this.options.directorUrl,
          region: cache.region,
          ttlMs: cache.expiresAt - now
        })
      )
      return cache.region ?? undefined
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

  // Bad cached measurements can pin distant cells for a day; probe the assigned cell to self-heal.
  async invalidateIfAssignedCellIsFar(assignedCellOrigin: string): Promise<void> {
    if (this.overrideRegion() || this.selfHealedCells.has(assignedCellOrigin)) {
      return
    }
    const now = (this.options.now ?? Date.now)()
    const cache = readRelayRegionCache(this.cachePath(), this.options.directorUrl, now)
    if (!cache?.region || cache.expiresAt <= now) {
      return
    }
    this.selfHealedCells.add(assignedCellOrigin)
    const outcome: Omit<RelayRegionSelfHealLogEvent, 'directorHost'> = {
      event: RELAY_REGION_SELF_HEAL_EVENT,
      cachedRegion: cache.region,
      bestRegion: null,
      bestLatencyMs: null,
      assignedCellUrl: assignedCellOrigin,
      assignedLatencyMs: null,
      decision: 'kept',
      reason: 'catalog-unavailable'
    }
    try {
      const fetch = this.options.fetch ?? globalThis.fetch
      const probe = this.createProbe(fetch)
      const reports = await this.probeCatalog(fetch, () => this.logSelfHeal(outcome))
      const best = bestMeasurement(measuredRegions(reports))
      outcome.bestRegion = best?.region ?? null
      outcome.bestLatencyMs = best?.latencyMs ?? null
      outcome.reason = best ? 'best-matches-cache' : 'no-region-measured'
      // The director may decline the best-region hint; deleting it would only trigger identical probes.
      if (!best || best.region === cache.region) {
        this.logSelfHeal(outcome)
        return
      }
      const assignedMs = await measureOriginLatency(assignedCellOrigin, probe)
      outcome.assignedLatencyMs = assignedMs
      const far = assignedMs !== null && assignedMs > best.latencyMs * FAR_CELL_RATIO
      outcome.decision = far ? 'deleted' : 'kept'
      outcome.reason = far ? 'assigned-cell-far' : 'assigned-cell-near'
      if (far) {
        rmSync(this.cachePath(), { force: true })
      }
      this.logSelfHeal(outcome)
    } catch {}
  }

  private logSelfHeal(outcome: Omit<RelayRegionSelfHealLogEvent, 'directorHost'>): void {
    this.log({ ...outcome, directorHost: relayDirectorHost(this.options.directorUrl) })
  }

  private async refresh(
    previous: RelayRegionCache | null,
    now: number
  ): Promise<RelayRegion | undefined> {
    const fetch = this.options.fetch ?? globalThis.fetch
    // Refresh reports catalog failure as no hint; self-heal reports its separate outcome.
    const reports = await this.probeCatalog(fetch, () =>
      this.log(relayRegionCatalogFailureEvent(this.options.directorUrl))
    )
    const measurements = measuredRegions(reports)
    // A region must beat measured competitors; absent/unmeasurable peers defer placement to the director.
    // Withholding lasts one hour; an uncontested hint would pin a roll-wave survivor for a day.
    const selected =
      measurements.length < reports.length || reports.length < RELAY_REGIONS.length
        ? null
        : selectRegionMeasurement(measurements, previous?.region ?? null)
    const ttlMs = selected ? CACHE_TTL_MS : NO_HINT_TTL_MS
    this.log(
      relayRegionRefreshEvent({
        directorUrl: this.options.directorUrl,
        reports,
        best: bestMeasurement(measurements),
        selected,
        ttlMs
      })
    )
    this.writeCache(
      selected
        ? { region: selected.region, latencyMs: selected.latencyMs, ttlMs }
        : { region: null, ttlMs },
      now
    )
    return selected?.region
  }

  private async probeCatalog(
    fetch: typeof globalThis.fetch,
    onCatalogFailure?: () => void
  ): Promise<RelayRegionProbeReport[]> {
    let catalog: RelayRegionCatalog
    try {
      catalog = await fetchRelayRegionCatalog(
        this.options.directorUrl,
        fetch,
        this.options.requestTimeoutMs ?? PROBE_TIMEOUT_MS
      )
    } catch (error) {
      onCatalogFailure?.()
      throw error
    }
    const probe = this.createProbe(fetch)
    return await Promise.all(catalog.regions.map((entry) => measureRegion(entry, probe)))
  }

  private log(event: Parameters<RelayRegionLogSink>[0]): void {
    ;(this.options.logEvent ?? logRelayRegionEvent)(event)
  }

  private writeCache(
    entry: { region: RelayRegion | null; latencyMs?: number; ttlMs: number },
    now: number
  ): void {
    try {
      writeSecureJsonFile(this.cachePath(), {
        v: 2,
        directorUrl: this.options.directorUrl,
        region: entry.region,
        ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
        expiresAt: now + entry.ttlMs
      } satisfies RelayRegionCache)
    } catch {}
  }

  private overrideRegion(): RelayRegion | undefined {
    const override = RelayRegionSchema.safeParse(
      this.options.diagnosticOverride ?? process.env.ORCA_RELAY_REGION_OVERRIDE
    )
    return override.success ? override.data : undefined
  }

  private cachePath(): string {
    return join(this.options.userDataPath, RELAY_REGION_CACHE_FILENAME)
  }

  private createProbe(fetch: typeof globalThis.fetch): RelayProbe {
    return (
      this.options.probe ??
      ((origin: string) =>
        probeRelayOrigin(
          origin,
          fetch,
          this.options.measureNow ?? (() => performance.now()),
          this.options.requestTimeoutMs ?? PROBE_TIMEOUT_MS
        ))
    )
  }
}

function measuredRegions(reports: RelayRegionProbeReport[]): RegionMeasurement[] {
  return reports
    .map(regionMeasurement)
    .filter((measurement): measurement is RegionMeasurement => measurement !== null)
}

function bestMeasurement(measurements: RegionMeasurement[]): RegionMeasurement | null {
  const order = new Map(RELAY_REGIONS.map((region, index) => [region, index]))
  return (
    [...measurements].sort(
      (left, right) =>
        left.latencyMs - right.latencyMs || order.get(left.region)! - order.get(right.region)!
    )[0] ?? null
  )
}

function selectRegionMeasurement(
  measurements: RegionMeasurement[],
  previousRegion: RelayRegion | null
): RegionMeasurement | null {
  const best = bestMeasurement(measurements)
  if (!best || !previousRegion || best.region === previousRegion) {
    return best
  }
  const current = measurements.find((measurement) => measurement.region === previousRegion)
  if (!current) {
    return best
  }
  const meaningful =
    current.latencyMs - best.latencyMs >= SWITCH_MINIMUM_MS &&
    best.latencyMs <= current.latencyMs * SWITCH_RATIO
  return meaningful ? best : current
}

function readRelayRegionCache(path: string, directorUrl: string, now: number) {
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
