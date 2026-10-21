import { z } from 'zod'
import type { RelayOpsEnvironment } from './environment-config.js'
import {
  googleJson,
  MonitoringPointSchema,
  MonitoringResponseSchema,
  pointValue
} from './incident-monitor-sources.js'
import {
  attributeCellExits,
  PRE_DRAIN_HARD_RULES,
  type PreDrainHardRuleReadings
} from './pre-drain-sample.js'

// The Docker `container die` count per relay cell, from infra/terraform/relay-observability.tf.
export const CELL_PROCESS_EXIT_METRIC = 'logging.googleapis.com/user/orca_relay_cell_process_exit'

// How far back a cell's own runtime-metrics line is searched to name an instance. The instance id
// survives a container restart, so a crash-looping container is still named by its earlier lines.
export const INSTANCE_CELL_LOOKBACK_MS = 2 * 60 * 60_000

const ExitsByInstanceSchema = z.object({
  timeSeries: z.array(z.object({
    resource: z.object({ labels: z.object({ instance_id: z.string().regex(/^[0-9]+$/) }) }),
    points: z.array(MonitoringPointSchema)
  })).default([]),
  nextPageToken: z.string().optional()
})

const RuntimeMetricsEntriesSchema = z.object({
  entries: z.array(z.object({
    jsonPayload: z.object({ cellId: z.string() })
  })).default([])
})

export type PreDrainExitScope = {
  targetCellId: string
  placementCellIds: ReadonlySet<string>
  configuredCellIds: ReadonlySet<string>
}

type AlignedRead = {
  filter: string
  lookbackMs: number
  aligner: 'ALIGN_DELTA' | 'ALIGN_PERCENTILE_99'
  reducer: 'REDUCE_SUM' | 'REDUCE_MAX'
}

// Server-side per-minute alignment, so a burst is counted rather than sampled and no read can be
// truncated the way a log read is.
async function readPerMinute(
  environment: RelayOpsEnvironment,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  read: AlignedRead
): Promise<number[]> {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${environment.project}/timeSeries`
  )
  url.searchParams.set('filter', read.filter)
  url.searchParams.set('interval.startTime', new Date(nowMs - read.lookbackMs).toISOString())
  url.searchParams.set('interval.endTime', new Date(nowMs).toISOString())
  url.searchParams.set('aggregation.alignmentPeriod', '60s')
  url.searchParams.set('aggregation.perSeriesAligner', read.aligner)
  url.searchParams.set('aggregation.crossSeriesReducer', read.reducer)
  url.searchParams.set('pageSize', '1000')
  const parsed = MonitoringResponseSchema.parse(await googleJson(fetchImpl, token, url))
  if (parsed.nextPageToken) throw new Error('Google metric pagination is incomplete')
  return parsed.timeSeries.flatMap((series) => series.points.map(pointValue))
}

function directorFilter(environment: RelayOpsEnvironment, metricType: string): string {
  return [
    `metric.type="${metricType}"`,
    'resource.type="cloud_run_revision"',
    `resource.label."service_name"="${environment.directorService}"`
  ].join(' AND ')
}

async function readExitsByInstance(
  environment: RelayOpsEnvironment,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number
): Promise<Map<string, number>> {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${environment.project}/timeSeries`
  )
  url.searchParams.set(
    'filter',
    `metric.type="${CELL_PROCESS_EXIT_METRIC}" AND resource.type="gce_instance"`
  )
  url.searchParams.set(
    'interval.startTime',
    new Date(nowMs - PRE_DRAIN_HARD_RULES.cellProcessExitLookbackMs).toISOString()
  )
  url.searchParams.set('interval.endTime', new Date(nowMs).toISOString())
  url.searchParams.set('aggregation.alignmentPeriod', '60s')
  url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_SUM')
  url.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_SUM')
  url.searchParams.set('aggregation.groupByFields', 'resource.label."instance_id"')
  url.searchParams.set('pageSize', '1000')
  const parsed = ExitsByInstanceSchema.parse(await googleJson(fetchImpl, token, url))
  if (parsed.nextPageToken) throw new Error('Google metric pagination is incomplete')
  const exits = new Map<string, number>()
  for (const series of parsed.timeSeries) {
    const instanceId = series.resource.labels.instance_id
    const total = series.points.map(pointValue).reduce((sum, value) => sum + value, 0)
    exits.set(instanceId, (exits.get(instanceId) ?? 0) + total)
  }
  return exits
}

// The cell an instance serves, from that instance's own newest runtime-metrics line; the exit
// metric carries only the instance id. Null when the instance logged none in the lookback.
async function readInstanceCell(
  environment: RelayOpsEnvironment,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  instanceId: string
): Promise<string | null> {
  const since = new Date(nowMs - INSTANCE_CELL_LOOKBACK_MS).toISOString()
  const body = RuntimeMetricsEntriesSchema.parse(await googleJson(
    fetchImpl,
    token,
    'https://logging.googleapis.com/v2/entries:list',
    {
      method: 'POST',
      body: JSON.stringify({
        resourceNames: [`projects/${environment.project}`],
        filter: [
          'resource.type="gce_instance"',
          `resource.labels.instance_id="${instanceId}"`,
          'jsonPayload.event="orca_relay_runtime_metrics"',
          `timestamp>="${since}"`
        ].join(' AND '),
        orderBy: 'timestamp desc',
        pageSize: 1
      })
    }
  ))
  return body.entries[0]?.jsonPayload.cellId ?? null
}

export function createPreDrainHardRuleReader(
  environment: RelayOpsEnvironment,
  accessToken: () => Promise<string>,
  scope: PreDrainExitScope,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {}
): () => Promise<PreDrainHardRuleReadings> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  // An exit count of zero is only evidence if the metric exists; a renamed or deleted log metric
  // reads as an empty, calm series forever. Checked once, before the first reading is trusted.
  let descriptorChecked: Promise<void> | null = null
  const requireExitMetric = (token: string): Promise<void> => {
    descriptorChecked ??= googleJson(
      fetchImpl,
      token,
      `https://monitoring.googleapis.com/v3/projects/${environment.project}` +
        `/metricDescriptors/${CELL_PROCESS_EXIT_METRIC}`
    ).then(() => undefined, (error: unknown) => {
      descriptorChecked = null
      throw error
    })
    return descriptorChecked
  }
  // An instance belongs to one cell for its whole life, so a resolved name is kept; an unresolved
  // one is asked again next sample.
  const cellByInstance = new Map<string, string>()
  return async () => {
    const token = await accessToken()
    await requireExitMetric(token)
    const nowMs = now()
    const [exitsByInstance, director503, concurrency] = await Promise.all([
      readExitsByInstance(environment, token, fetchImpl, nowMs),
      readPerMinute(environment, token, fetchImpl, nowMs, {
        filter: `${directorFilter(environment, 'run.googleapis.com/request_count')}` +
          ' AND metric.label."response_code"="503"',
        lookbackMs: PRE_DRAIN_HARD_RULES.director503LookbackMs,
        aligner: 'ALIGN_DELTA',
        reducer: 'REDUCE_SUM'
      }),
      readPerMinute(environment, token, fetchImpl, nowMs, {
        filter: `${directorFilter(
          environment,
          'run.googleapis.com/container/max_request_concurrencies'
        )} AND metric.label."state"="active"`,
        lookbackMs: PRE_DRAIN_HARD_RULES.directorConcurrencyLookbackMs,
        aligner: 'ALIGN_PERCENTILE_99',
        reducer: 'REDUCE_MAX'
      })
    ])
    const resolved = new Map<string, string | null>()
    for (const [instanceId, exits] of exitsByInstance) {
      if (exits <= 0) continue
      const known = cellByInstance.get(instanceId)
      const cellId = known ?? await readInstanceCell(environment, token, fetchImpl, nowMs, instanceId)
      if (cellId !== null) cellByInstance.set(instanceId, cellId)
      resolved.set(instanceId, cellId)
    }
    const attribution = attributeCellExits({
      exitsByInstance,
      cellByInstance: resolved,
      ...scope
    })
    return {
      cellProcessExits: attribution.counted,
      unattributedExitInstances: attribution.unattributed,
      // 503s are a counter, so a minute with no point had none.
      director503PeakPerMinute: Math.max(0, ...director503),
      directorConcurrencyP99: concurrency.length === 0 ? null : Math.max(...concurrency)
    }
  }
}
