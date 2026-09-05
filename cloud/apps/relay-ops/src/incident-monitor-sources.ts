import { z } from 'zod'
import { buildDashboardSnapshot } from './dashboard-snapshot.js'
import type {
  RelayOpsEnvironment,
  RelayOpsEnvironmentId
} from './environment-config.js'
import { relayOpsEnvironment } from './environment-config.js'
import type { GcloudClient } from './gcloud-client.js'
import type { RelayMetricSnapshot } from './monitoring-snapshot.js'
import {
  AdmissionSelectorSchema,
  effectiveAdmissionState,
  normalizeSelectorMembership,
  selectorCellState,
  type AdmissionSelector,
} from './incident-selector.js'
import {
  INCIDENT_MONITOR_THRESHOLDS,
  type IncidentSample,
  type IncidentSignal,
  type IncidentSource
} from './incident-monitor.js'

const NumericSchema = z.union([z.number(), z.string()])
  .transform(Number)
  .pipe(z.number().finite())
const MonitoringPointSchema = z.object({
  interval: z.object({ endTime: z.string() }),
  value: z.object({
    doubleValue: NumericSchema.optional(),
    int64Value: NumericSchema.optional(),
    distributionValue: z.object({
      mean: NumericSchema.optional(),
      range: z.object({ max: NumericSchema.optional() }).optional()
    }).optional()
  })
})
const MonitoringResponseSchema = z.object({
  timeSeries: z.array(z.object({ points: z.array(MonitoringPointSchema) })).default([]),
  nextPageToken: z.string().optional()
})
const CellStatusSchema = z.object({
  status: z.object({
    enabled: z.boolean(),
    connectionCapacity: z
      .object({ hardCap: z.number().int().positive() })
      .nullable(),
    runtime: z.object({
      lastHeartbeatAt: z.number(),
      heartbeatFresh: z.boolean()
    }).nullable()
  })
})
const SelectorStatusSchema = z.object({
  selector: AdmissionSelectorSchema
})
const MigrationStatusSchema = z.object({
  blocked: z.number().int().nonnegative(),
  registeredTargetInactive: z.number().int().nonnegative(),
  blockedExpiredUnregistered: z.number().int().nonnegative()
})

export type GoogleMetricDefinition = {
  signal: string
  type: string
  resourceFilter: string
  aggregation: 'latest-max' | 'latest-sum' | 'window-sum'
  emptyIsZero?: boolean
  zeroAfterMs?: number
}

export const GOOGLE_METRICS: GoogleMetricDefinition[] = [
  {
    signal: 'cloud_sql.cpu',
    type: 'cloudsql.googleapis.com/database/cpu/utilization',
    resourceFilter: 'resource.type="cloudsql_database"',
    aggregation: 'latest-max'
  },
  {
    signal: 'cloud_sql.memory',
    type: 'cloudsql.googleapis.com/database/memory/utilization',
    resourceFilter: 'resource.type="cloudsql_database"',
    aggregation: 'latest-max'
  },
  {
    signal: 'cloud_sql.backends',
    type: 'cloudsql.googleapis.com/database/postgresql/num_backends',
    resourceFilter: 'resource.type="cloudsql_database"',
    aggregation: 'latest-sum'
  },
  {
    signal: 'cloud_sql.lock_waits',
    type: 'cloudsql.googleapis.com/database/postgresql/backends_in_wait',
    resourceFilter:
      'resource.type="cloudsql_database" AND metric.label."wait_event_type"="Lock"',
    aggregation: 'latest-max',
    emptyIsZero: true,
    zeroAfterMs: INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs
  },
  {
    signal: 'cloud_sql.deadlocks',
    type: 'cloudsql.googleapis.com/database/postgresql/deadlock_count',
    resourceFilter: 'resource.type="cloudsql_database"',
    aggregation: 'window-sum',
    emptyIsZero: true
  },
  {
    signal: 'director.instances',
    type: 'run.googleapis.com/container/instance_count',
    resourceFilter: 'resource.type="cloud_run_revision"',
    aggregation: 'latest-sum'
  },
  {
    signal: 'director.cpu',
    type: 'run.googleapis.com/container/cpu/utilizations',
    resourceFilter: 'resource.type="cloud_run_revision"',
    aggregation: 'latest-max'
  },
  {
    signal: 'director.memory',
    type: 'run.googleapis.com/container/memory/utilizations',
    resourceFilter: 'resource.type="cloud_run_revision"',
    aggregation: 'latest-max'
  },
  {
    signal: 'director.concurrency',
    type: 'run.googleapis.com/container/max_request_concurrencies',
    resourceFilter:
      'resource.type="cloud_run_revision" AND metric.label."state"="active"',
    aggregation: 'latest-max'
  },
  {
    signal: 'director.errors',
    type: 'run.googleapis.com/request_count',
    resourceFilter:
      'resource.type="cloud_run_revision" AND metric.label."response_code_class"="5xx" AND metric.label."response_code"!="503"',
    aggregation: 'window-sum',
    emptyIsZero: true
  },
  {
    signal: 'auth.errors',
    type: 'run.googleapis.com/request_count',
    resourceFilter:
      'resource.type="cloud_run_revision" AND metric.label."response_code_class"="5xx"',
    aggregation: 'window-sum',
    emptyIsZero: true
  }
]

function pointValue(point: z.infer<typeof MonitoringPointSchema>): number {
  return (
    point.value.doubleValue ??
    point.value.int64Value ??
    point.value.distributionValue?.range?.max ??
    point.value.distributionValue?.mean ??
    0
  )
}

function serviceFilter(signal: string, directorService: string, authService: string): string {
  if (signal.startsWith('director.')) {
    return `resource.label."service_name"="${directorService}"`
  }
  if (signal.startsWith('auth.')) {
    return `resource.label."service_name"="${authService}"`
  }
  return ''
}

function targetFilter(
  definition: GoogleMetricDefinition,
  environment: RelayOpsEnvironment
): string {
  if (definition.signal.startsWith('cloud_sql.')) {
    return `resource.label."database_id"="${environment.project}:${environment.sqlInstance}"`
  }
  return serviceFilter(
    definition.signal,
    environment.directorService,
    environment.authService
  )
}

async function googleJson(
  fetchImpl: typeof fetch,
  token: string,
  url: URL | string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {})
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Google telemetry returned ${response.status}`)
  return await response.json()
}

export async function readGoogleMetric(
  environment: RelayOpsEnvironment,
  definition: GoogleMetricDefinition,
  token: string,
  startAt: string,
  endAt: string,
  fetchImpl: typeof fetch,
  now: () => number = () => Date.parse(endAt)
): Promise<IncidentSignal | null> {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${environment.project}/timeSeries`
  )
  const filters = [
    `metric.type="${definition.type}"`,
    definition.resourceFilter,
    targetFilter(definition, environment)
  ].filter(Boolean)
  url.searchParams.set('filter', filters.join(' AND '))
  url.searchParams.set('interval.startTime', startAt)
  url.searchParams.set('interval.endTime', endAt)
  url.searchParams.set('view', 'FULL')
  url.searchParams.set('pageSize', '1000')
  const parsed = MonitoringResponseSchema.parse(
    await googleJson(fetchImpl, token, url)
  )
  if (parsed.nextPageToken) throw new Error('Google metric pagination is incomplete')
  const queryEndMs = Date.parse(endAt)
  const readAtMs = Math.max(queryEndMs, now())
  const readAt = new Date(readAtMs).toISOString()
  const points = parsed.timeSeries.flatMap((series) => series.points)
  if (points.length === 0) {
    return definition.emptyIsZero ? { value: 0, observedAt: readAt } : null
  }
  const zeroAfterMs = definition.zeroAfterMs
  if (definition.emptyIsZero && zeroAfterMs !== undefined) {
    const latestSeriesPoints = parsed.timeSeries.flatMap((series) => {
      const seriesNewestAt = Math.max(
        ...series.points.map((point) => Date.parse(point.interval.endTime))
      )
      return series.points.filter(
        (point) => Date.parse(point.interval.endTime) === seriesNewestAt
      )
    })
    const futurePoints = latestSeriesPoints.filter(
      (point) => Date.parse(point.interval.endTime) > queryEndMs
    )
    if (futurePoints.length > 0) {
      return {
        value: Math.max(...futurePoints.map(pointValue)),
        observedAt: new Date(Math.max(
          ...futurePoints.map((point) => Date.parse(point.interval.endTime))
        )).toISOString()
      }
    }
    const recentNonzero = latestSeriesPoints.filter((point) => {
      const pointAt = Date.parse(point.interval.endTime)
      return pointValue(point) > 0 && queryEndMs - pointAt <= zeroAfterMs
    })
    if (recentNonzero.length === 0) return { value: 0, observedAt: readAt }
    return {
      value: Math.max(...recentNonzero.map(pointValue)),
      observedAt: new Date(Math.min(
        ...recentNonzero.map((point) => Date.parse(point.interval.endTime))
      )).toISOString()
    }
  }
  const newestAt = Math.max(...points.map((point) => Date.parse(point.interval.endTime)))
  const selected = definition.aggregation === 'window-sum'
    ? points
    : points.filter((point) => Date.parse(point.interval.endTime) === newestAt)
  const values = selected.map(pointValue)
  const value =
    definition.aggregation !== 'latest-max'
      ? values.reduce((total, entry) => total + entry, 0)
      : Math.max(...values)
  return {
    value,
    observedAt: new Date(newestAt).toISOString()
  }
}

export async function readGoogleMetricWithEmptyRetry(
  environment: RelayOpsEnvironment,
  definition: GoogleMetricDefinition,
  token: string,
  startAt: string,
  endAt: string,
  fetchImpl: typeof fetch,
  now: () => number = () => Date.parse(endAt),
  wait: (ms: number) => Promise<void> = async (ms) =>
    await new Promise((resolve) => setTimeout(resolve, ms))
): Promise<IncidentSignal | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = await readGoogleMetric(
      environment,
      definition,
      token,
      startAt,
      endAt,
      fetchImpl,
      now
    )
    if (signal !== null || definition.emptyIsZero) return signal
    if (attempt < 2) await wait(2_000)
  }
  return null
}

function addSignal(
  signals: Record<string, IncidentSignal>,
  name: string,
  value: number | null,
  observedAt: string | null
): void {
  if (value === null || observedAt === null) return
  signals[name] = { value, observedAt }
}

function endpointSignals(
  snapshot: Awaited<ReturnType<typeof buildDashboardSnapshot>>,
  nowAt: string
): IncidentSource {
  const signals: Record<string, IncidentSignal> = {}
  const addEndpoint = (
    prefix: string,
    endpoint: { health: boolean | null; ready: boolean | null; latencyMs: number | null },
    unavailableIsZero = false
  ) => {
    addSignal(
      signals,
      `${prefix}.health`,
      endpoint.health === null ? (unavailableIsZero ? 0 : null) : Number(endpoint.health),
      nowAt
    )
    addSignal(
      signals,
      `${prefix}.ready`,
      endpoint.ready === null ? (unavailableIsZero ? 0 : null) : Number(endpoint.ready),
      nowAt
    )
    addSignal(signals, `${prefix}.latency_ms`, endpoint.latencyMs, nowAt)
  }
  addEndpoint('director', snapshot.resources.directorEndpoint)
  addEndpoint('auth', snapshot.resources.authEndpoint)
  for (const cell of snapshot.resources.cells) {
    addEndpoint(`cell.${cell.cellId}`, cell.endpoint, true)
  }
  return { observedAt: nowAt, signals }
}

export function relayFiveMinuteDeltaSignal(
  metric: Pick<RelayMetricSnapshot, 'available' | 'points'>,
  endAt: string
): IncidentSignal | null {
  if (!metric.available) return null
  const endMs = Date.parse(endAt)
  if (!Number.isFinite(endMs)) throw new Error('Relay telemetry end time is invalid')
  return {
    value: metric.points
      .filter((point) => {
        const pointMs = Date.parse(point.at)
        return pointMs >= endMs - 300_000 && pointMs <= endMs
      })
      .reduce((total, point) => total + point.value, 0),
    observedAt: endAt
  }
}

function relaySignals(
  snapshot: Awaited<ReturnType<typeof buildDashboardSnapshot>>
): IncidentSource {
  const metrics = snapshot.monitoring.metrics
  const signals: Record<string, IncidentSignal> = {}
  addSignal(
    signals,
    'relay.pool_waiting',
    metrics.db_waiters_max.latest,
    metrics.db_waiters_max.latestAt
  )
  addSignal(
    signals,
    'relay.pool_wait_ms',
    metrics.db_wait_ms_max.latest,
    metrics.db_wait_ms_max.latestAt
  )
  const retries = relayFiveMinuteDeltaSignal(
    metrics.postgres_retries,
    snapshot.monitoring.endAt
  )
  if (retries) signals['relay.postgres_retries'] = retries
  const retryExhausted = relayFiveMinuteDeltaSignal(
    metrics.postgres_retry_exhausted,
    snapshot.monitoring.endAt
  )
  if (retryExhausted) signals['relay.postgres_retry_exhausted'] = retryExhausted
  for (const cell of snapshot.resources.cells) {
    addSignal(
      signals,
      `cell.${cell.cellId}.connections`,
      metrics.total_connections.latestByCell[cell.cellId] ?? null,
      metrics.total_connections.latestAt
    )
    addSignal(
      signals,
      `cell.${cell.cellId}.queued_bytes`,
      metrics.queued_bytes.latestByCell[cell.cellId] ?? null,
      metrics.queued_bytes.latestAt
    )
  }
  const observedTimes = Object.values(signals).map((entry) => Date.parse(entry.observedAt))
  if (observedTimes.length === 0) throw new Error('Relay telemetry is unavailable')
  const observedAt = new Date(Math.max(...observedTimes)).toISOString()
  return { observedAt, signals }
}

async function adminPost(
  fetchImpl: typeof fetch,
  origin: string,
  token: string,
  path: string,
  body: unknown
): Promise<unknown> {
  const response = await fetchImpl(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Relay admin telemetry returned ${response.status}`)
  return await response.json()
}

export async function directorSignals(
  environmentId: RelayOpsEnvironmentId,
  expectedSelector: AdmissionSelector,
  gcloud: GcloudClient,
  nowMs: number,
  fetchImpl: typeof fetch
): Promise<{
  source: IncidentSource
  selector: AdmissionSelector
  cells: IncidentSample['cells']
}> {
  const environment = relayOpsEnvironment(environmentId)
  if (!gcloud.identityToken) throw new Error('gcloud identity-token support is unavailable')
  const token = await gcloud.identityToken(`${environment.directorOrigin}/v1/admin/drain`)
  const configuredCellIds = new Set(environment.cells.map((cell) => cell.cellId))
  const rawSelector = SelectorStatusSchema.parse(
    await adminPost(
      fetchImpl,
      environment.directorOrigin,
      token,
      '/v1/admin/admission-selector/status',
      { v: 1 }
    )
  ).selector
  const selector = {
    generation: rawSelector.generation,
    membership: normalizeSelectorMembership(rawSelector.membership, configuredCellIds)
  }
  const statuses: Array<{
    cell: RelayOpsEnvironment['cells'][number]
    status: z.infer<typeof CellStatusSchema>['status']
  }> = []
  for (const cell of environment.cells) {
    statuses.push({
      cell,
      status: CellStatusSchema.parse(
        await adminPost(fetchImpl, environment.directorOrigin, token, '/v1/admin/cell-status', {
          v: 1,
          cellId: cell.cellId
        })
      ).status
    })
  }
  const migrationEntries: Array<{
    sourceCellId: string
    migration: z.infer<typeof MigrationStatusSchema>
  }> = []
  const migrationTargets = new Set(expectedSelector.membership.migrationOnly)
  for (const source of environment.cells) {
    for (const target of environment.cells) {
      if (source.cellId === target.cellId || !migrationTargets.has(target.cellId)) continue
      migrationEntries.push({
        sourceCellId: source.cellId,
        migration: MigrationStatusSchema.parse(
          await adminPost(
            fetchImpl,
            environment.directorOrigin,
            token,
            '/v1/admin/evacuation-status',
            {
              v: 1,
              sourceCellId: source.cellId,
              targetCellId: target.cellId,
              completeReady: false
            }
          )
        )
      })
    }
  }
  const migrationBySource = new Map<string, { blocked: number; targetInactive: number }>()
  for (const { sourceCellId, migration } of migrationEntries) {
    const aggregate = migrationBySource.get(sourceCellId) ?? { blocked: 0, targetInactive: 0 }
    aggregate.blocked += migration.blocked + migration.blockedExpiredUnregistered
    aggregate.targetInactive += migration.registeredTargetInactive
    migrationBySource.set(sourceCellId, aggregate)
  }
  const nowAt = new Date(nowMs).toISOString()
  const signals: Record<string, IncidentSignal> = {}
  for (const { cell, status } of statuses) {
    const prefix = `cell.${cell.cellId}`
    const admissionState = effectiveAdmissionState(
      selector,
      status.enabled,
      cell.cellId
    )
    addSignal(
      signals,
      `${prefix}.admission_state`,
      ['existing-only', 'migration-only', 'general'].indexOf(admissionState),
      nowAt
    )
    addSignal(
      signals,
      `${prefix}.connection_hard_cap`,
      status.connectionCapacity?.hardCap ??
        INCIDENT_MONITOR_THRESHOLDS.cellConnections,
      nowAt
    )
    if (status.runtime) {
      addSignal(
        signals,
        `${prefix}.heartbeat_fresh`,
        Number(status.runtime.heartbeatFresh),
        nowAt
      )
      addSignal(
        signals,
        `${prefix}.heartbeat_age_ms`,
        Math.max(0, nowMs - status.runtime.lastHeartbeatAt),
        nowAt
      )
    }
    const migration = migrationBySource.get(cell.cellId) ?? { blocked: 0, targetInactive: 0 }
    addSignal(signals, `${prefix}.migration_blocked`, migration.blocked, nowAt)
    addSignal(
      signals,
      `${prefix}.migration_target_inactive`,
      migration.targetInactive,
      nowAt
    )
  }
  return {
    source: { observedAt: nowAt, signals },
    selector,
    cells: statuses.map(({ cell }) => ({
      cellId: cell.cellId,
      runtimeKnown: true,
      powered: true,
      expectedAdmissionState: selectorCellState(expectedSelector, cell.cellId)
    }))
  }
}

export type IncidentSampleCollectorOptions = {
  environment: RelayOpsEnvironmentId
  expectedSelector: AdmissionSelector
  fetchImpl?: typeof fetch
  now?: () => number
}

export function createIncidentSampleCollector(
  gcloud: GcloudClient,
  options: IncidentSampleCollectorOptions
): () => Promise<IncidentSample> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  return async () => {
    const nowMs = now()
    const nowAt = new Date(nowMs).toISOString()
    const startAt = new Date(nowMs - 5 * 60_000).toISOString()
    const environment = relayOpsEnvironment(options.environment)
    const accessToken = gcloud.accessToken()
    const cloudMetricEntries = accessToken.then(async (token) => await Promise.all(
      GOOGLE_METRICS.map(async (definition) => [
        definition.signal,
        await readGoogleMetricWithEmptyRetry(
          environment,
          definition,
          token,
          startAt,
          nowAt,
          fetchImpl,
          now
        )
      ] as const)
    ))
    const [snapshot, director, metricEntries] = await Promise.all([
      buildDashboardSnapshot(options.environment, gcloud, {
        windowMinutes: 5,
        now: new Date(nowMs),
        fetchImpl
      }),
      directorSignals(
        options.environment,
        options.expectedSelector,
        gcloud,
        nowMs,
        fetchImpl
      ),
      cloudMetricEntries
    ])
    const cloudSignals = Object.fromEntries(
      metricEntries.filter((entry): entry is [string, IncidentSignal] => entry[1] !== null)
    )
    const relay = relaySignals(snapshot)
    const poweredByCell = new Map(
      snapshot.resources.cells.map((cell) => [
        cell.cellId,
        {
          runtimeKnown: cell.targetSize !== null,
          powered: (cell.targetSize ?? 0) > 0
        }
      ])
    )
    return {
      collectedAt: nowAt,
      selector: director.selector,
      expectedSelector: options.expectedSelector,
      sources: {
        'active-probe': endpointSignals(snapshot, nowAt),
        'cloud-monitoring': { observedAt: nowAt, signals: cloudSignals },
        'relay-logs': relay,
        'director-admin': director.source
      },
      cells: director.cells.map((cell) => ({
        ...cell,
        runtimeKnown: poweredByCell.get(cell.cellId)?.runtimeKnown ?? false,
        powered: poweredByCell.get(cell.cellId)?.powered ?? false
      }))
    }
  }
}
