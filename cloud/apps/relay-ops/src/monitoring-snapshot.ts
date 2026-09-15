import { z } from 'zod'
import type { RelayOpsEnvironment } from './environment-config.js'
import type { GcloudClient } from './gcloud-client.js'

type MetricMode = 'gauge-sum' | 'delta-sum' | 'maximum'

export type RelayMetricName =
  | 'total_connections'
  | 'controls'
  | 'splices'
  | 'pending_splices'
  | 'queued_bytes'
  | 'http_latency_ms'
  | 'sql_latency_ms'
  | 'heap_used_bytes'
  | 'event_loop_ms_p99'
  | 'forwarded_bytes'
  | 'auth_successes'
  | 'auth_failures'
  | 'reconnects'
  | 'sql_queries'
  | 'sql_failures'
  | 'assignment_5xx'
  | 'postgres_retries'
  | 'postgres_retry_exhausted'
  | 'db_pool_total'
  | 'db_pool_idle'
  | 'db_pool_waiting'
  | 'db_waiters_max'
  | 'db_oldest_wait_ms'
  | 'db_wait_ms_max'

type MetricDefinition = {
  name: RelayMetricName
  label: string
  unit: 'count' | 'bytes' | 'milliseconds'
  mode: MetricMode
}

export const RELAY_METRICS: MetricDefinition[] = [
  { name: 'total_connections', label: 'Connections', unit: 'count', mode: 'gauge-sum' },
  { name: 'controls', label: 'Desktop controls', unit: 'count', mode: 'gauge-sum' },
  { name: 'splices', label: 'Phone splices', unit: 'count', mode: 'gauge-sum' },
  { name: 'pending_splices', label: 'Pending splices', unit: 'count', mode: 'gauge-sum' },
  { name: 'queued_bytes', label: 'Queued bytes', unit: 'bytes', mode: 'maximum' },
  { name: 'http_latency_ms', label: 'HTTP latency', unit: 'milliseconds', mode: 'maximum' },
  { name: 'sql_latency_ms', label: 'SQL latency', unit: 'milliseconds', mode: 'maximum' },
  { name: 'heap_used_bytes', label: 'Heap used', unit: 'bytes', mode: 'maximum' },
  {
    name: 'event_loop_ms_p99',
    label: 'Event-loop p99',
    unit: 'milliseconds',
    mode: 'maximum'
  },
  { name: 'forwarded_bytes', label: 'Forwarded bytes', unit: 'bytes', mode: 'delta-sum' },
  { name: 'auth_successes', label: 'Auth successes', unit: 'count', mode: 'delta-sum' },
  { name: 'auth_failures', label: 'Auth failures', unit: 'count', mode: 'delta-sum' },
  { name: 'reconnects', label: 'Reconnects', unit: 'count', mode: 'delta-sum' },
  { name: 'sql_queries', label: 'SQL queries', unit: 'count', mode: 'delta-sum' },
  { name: 'sql_failures', label: 'SQL failures', unit: 'count', mode: 'delta-sum' },
  { name: 'assignment_5xx', label: 'Assignment 5xx', unit: 'count', mode: 'delta-sum' },
  {
    name: 'postgres_retries',
    label: 'PostgreSQL retries',
    unit: 'count',
    mode: 'delta-sum'
  },
  {
    name: 'postgres_retry_exhausted',
    label: 'PostgreSQL retry exhausted',
    unit: 'count',
    mode: 'delta-sum'
  },
  { name: 'db_pool_total', label: 'Database pool total', unit: 'count', mode: 'gauge-sum' },
  { name: 'db_pool_idle', label: 'Database pool idle', unit: 'count', mode: 'gauge-sum' },
  {
    name: 'db_pool_waiting',
    label: 'Database pool waiting',
    unit: 'count',
    mode: 'gauge-sum'
  },
  {
    name: 'db_waiters_max',
    label: 'Database waiters max',
    unit: 'count',
    mode: 'maximum'
  },
  {
    name: 'db_oldest_wait_ms',
    label: 'Database oldest wait',
    unit: 'milliseconds',
    mode: 'maximum'
  },
  {
    name: 'db_wait_ms_max',
    label: 'Database wait max',
    unit: 'milliseconds',
    mode: 'maximum'
  }
]

const NumericSchema = z.union([z.number(), z.string()]).transform((value) => Number(value))
const DistributionSchema = z.object({
  count: NumericSchema.default(0),
  mean: NumericSchema.optional()
})
const PointSchema = z.object({
  interval: z.object({ endTime: z.string() }),
  value: z.object({
    doubleValue: NumericSchema.optional(),
    int64Value: NumericSchema.optional(),
    distributionValue: DistributionSchema.optional()
  })
})
const TimeSeriesSchema = z.object({
  metric: z.object({ labels: z.record(z.string()).default({}) }),
  resource: z.object({ type: z.string(), labels: z.record(z.string()).default({}) }),
  points: z.array(PointSchema).default([])
})
const TimeSeriesResponseSchema = z.object({
  timeSeries: z.array(TimeSeriesSchema).default([])
})

export type MetricPoint = { at: string; value: number }

export type RelayMetricSnapshot = MetricDefinition & {
  available: boolean
  points: MetricPoint[]
  latest: number | null
  latestAt: string | null
  latestByCell: Record<string, number>
}

export type AlertPolicySnapshot = {
  id: string
  displayName: string
  enabled: boolean
  documentation: string | null
}

export type MonitoringSnapshot = {
  startAt: string
  endAt: string
  resolutionSeconds: number
  metrics: Record<RelayMetricName, RelayMetricSnapshot>
  alertPolicies: AlertPolicySnapshot[]
  warnings: string[]
}

type ParsedPoint = {
  atMs: number
  bucketMs: number
  value: number
  sampleTotal: number
  seriesKey: string
  cellId: string
}

function pointValue(point: z.infer<typeof PointSchema>): { value: number; sampleTotal: number } {
  if (point.value.distributionValue) {
    const count = point.value.distributionValue.count
    const value = point.value.distributionValue.mean ?? 0
    return { value, sampleTotal: value * count }
  }
  const value = point.value.doubleValue ?? point.value.int64Value ?? 0
  return { value, sampleTotal: value }
}

function parsePoints(series: z.infer<typeof TimeSeriesSchema>[]): ParsedPoint[] {
  return series.flatMap((entry) => {
    const cellId = entry.metric.labels.cell_id ?? 'unknown'
    const resourceId =
      entry.resource.labels.instance_id ?? entry.resource.labels.revision_name ?? entry.resource.type
    const seriesKey = `${cellId}:${resourceId}`
    return entry.points.flatMap((point) => {
      const atMs = Date.parse(point.interval.endTime)
      if (!Number.isFinite(atMs)) return []
      const values = pointValue(point)
      return [{
        atMs,
        bucketMs: Math.floor(atMs / 60_000) * 60_000,
        value: values.value,
        sampleTotal: values.sampleTotal,
        seriesKey,
        cellId
      }]
    })
  })
}

function aggregatePoints(points: ParsedPoint[], mode: MetricMode): MetricPoint[] {
  if (mode === 'gauge-sum') {
    const buckets = new Map<number, Map<string, ParsedPoint>>()
    for (const point of points) {
      const bySeries = buckets.get(point.bucketMs) ?? new Map<string, ParsedPoint>()
      const previous = bySeries.get(point.seriesKey)
      if (!previous || previous.atMs < point.atMs) bySeries.set(point.seriesKey, point)
      buckets.set(point.bucketMs, bySeries)
    }
    return [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([at, bySeries]) => ({
        at: new Date(at).toISOString(),
        value: [...bySeries.values()].reduce((total, point) => total + point.value, 0)
      }))
  }
  const buckets = new Map<number, number>()
  for (const point of points) {
    const value = mode === 'delta-sum' ? point.sampleTotal : point.value
    const previous = buckets.get(point.bucketMs)
    buckets.set(
      point.bucketMs,
      mode === 'maximum' ? Math.max(previous ?? 0, value) : (previous ?? 0) + value
    )
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([at, value]) => ({ at: new Date(at).toISOString(), value }))
}

function latestByCell(points: ParsedPoint[], mode: MetricMode): Record<string, number> {
  const newestBucketByCell = new Map<string, number>()
  for (const point of points) {
    newestBucketByCell.set(
      point.cellId,
      Math.max(newestBucketByCell.get(point.cellId) ?? 0, point.bucketMs)
    )
  }
  const newestBySeries = new Map<string, ParsedPoint>()
  for (const point of points) {
    if (point.bucketMs !== newestBucketByCell.get(point.cellId)) continue
    const previous = newestBySeries.get(point.seriesKey)
    if (!previous || previous.atMs < point.atMs) newestBySeries.set(point.seriesKey, point)
  }
  const totals = new Map<string, number>()
  for (const point of newestBySeries.values()) {
    const value = mode === 'delta-sum' ? point.sampleTotal : point.value
    const previous = totals.get(point.cellId)
    totals.set(
      point.cellId,
      mode === 'maximum' ? Math.max(previous ?? 0, value) : (previous ?? 0) + value
    )
  }
  return Object.fromEntries(totals)
}

async function monitoringRequest(
  fetchImpl: typeof fetch,
  token: string,
  url: URL
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Cloud Monitoring returned ${response.status}`)
  return await response.json()
}

async function readMetric(
  environment: RelayOpsEnvironment,
  definition: MetricDefinition,
  token: string,
  startAt: string,
  endAt: string,
  fetchImpl: typeof fetch
): Promise<RelayMetricSnapshot> {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${environment.project}/timeSeries`
  )
  url.searchParams.set(
    'filter',
    `metric.type="logging.googleapis.com/user/orca_relay_${definition.name}"`
  )
  url.searchParams.set('interval.startTime', startAt)
  url.searchParams.set('interval.endTime', endAt)
  url.searchParams.set('view', 'FULL')
  url.searchParams.set('pageSize', '1000')
  const body = TimeSeriesResponseSchema.parse(
    await monitoringRequest(fetchImpl, token, url)
  )
  const parsed = parsePoints(body.timeSeries)
  const points = aggregatePoints(parsed, definition.mode)
  const latest = points.at(-1) ?? null
  return {
    ...definition,
    available: true,
    points,
    latest: latest?.value ?? null,
    latestAt: latest?.at ?? null,
    latestByCell: latestByCell(parsed, definition.mode)
  }
}

async function readAlertPolicies(
  environment: RelayOpsEnvironment,
  token: string,
  fetchImpl: typeof fetch
): Promise<AlertPolicySnapshot[]> {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${environment.project}/alertPolicies`
  )
  url.searchParams.set('pageSize', '100')
  const body = (await monitoringRequest(fetchImpl, token, url)) as {
    alertPolicies?: Array<{
      name?: string
      displayName?: string
      enabled?: boolean
      documentation?: { content?: string }
    }>
  }
  return (body.alertPolicies ?? [])
    .filter((policy) => policy.displayName?.startsWith('Orca Relay:'))
    .map((policy) => ({
      id: policy.name ?? '',
      displayName: policy.displayName ?? 'Orca Relay alert',
      enabled: policy.enabled === true,
      documentation: policy.documentation?.content ?? null
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}

function emptyMetric(definition: MetricDefinition): RelayMetricSnapshot {
  return {
    ...definition,
    available: false,
    points: [],
    latest: null,
    latestAt: null,
    latestByCell: {}
  }
}

export async function readMonitoringSnapshot(
  environment: RelayOpsEnvironment,
  gcloud: GcloudClient,
  options: { now?: Date; windowMinutes?: number; fetchImpl?: typeof fetch } = {}
): Promise<MonitoringSnapshot> {
  const now = options.now ?? new Date()
  const windowMinutes = Math.min(24 * 60, Math.max(30, options.windowMinutes ?? 360))
  const endAt = now.toISOString()
  const startAt = new Date(now.getTime() - windowMinutes * 60_000).toISOString()
  const fetchImpl = options.fetchImpl ?? fetch
  const warnings: string[] = []
  let token: string
  try {
    token = await gcloud.accessToken()
  } catch {
    return {
      startAt,
      endAt,
      resolutionSeconds: 60,
      metrics: Object.fromEntries(
        RELAY_METRICS.map((definition) => [definition.name, emptyMetric(definition)])
      ) as Record<RelayMetricName, RelayMetricSnapshot>,
      alertPolicies: [],
      warnings: ['Cloud Monitoring credentials are unavailable. Run gcloud auth login.']
    }
  }
  const settled = await Promise.allSettled(
    RELAY_METRICS.map((definition) =>
      readMetric(environment, definition, token, startAt, endAt, fetchImpl)
    )
  )
  const metrics = {} as Record<RelayMetricName, RelayMetricSnapshot>
  settled.forEach((result, index) => {
    const definition = RELAY_METRICS[index]!
    if (result.status === 'fulfilled') metrics[definition.name] = result.value
    else {
      metrics[definition.name] = emptyMetric(definition)
      warnings.push(`${definition.label} metric is unavailable.`)
    }
  })
  const alertPolicies = await readAlertPolicies(environment, token, fetchImpl).catch(() => {
    warnings.push('Cloud Monitoring alert policies are unavailable.')
    return []
  })
  return { startAt, endAt, resolutionSeconds: 60, metrics, alertPolicies, warnings }
}
