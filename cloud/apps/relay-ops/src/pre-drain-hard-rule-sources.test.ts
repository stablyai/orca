import { describe, expect, it } from 'vitest'
import { relayOpsEnvironment } from './environment-config.js'
import {
  CELL_PROCESS_EXIT_METRIC,
  createPreDrainHardRuleReader,
  INSTANCE_CELL_LOOKBACK_MS,
  type PreDrainExitScope
} from './pre-drain-hard-rule-sources.js'

const environment = relayOpsEnvironment('production')
const now = Date.parse('2026-10-01T12:00:00.000Z')
const scope: PreDrainExitScope = {
  targetCellId: 'production-gce-c25',
  placementCellIds: new Set(['production-gce-c25', 'production-gce-c26']),
  configuredCellIds: new Set(environment.cells.map((cell) => cell.cellId))
}

function points(values: number[], kind: 'int64Value' | 'doubleValue' = 'int64Value') {
  return values.map((value, index) => ({
    interval: { endTime: new Date(now - index * 60_000).toISOString() },
    value: { [kind]: kind === 'int64Value' ? String(value) : value }
  }))
}

type Fake = {
  // instance id -> per-minute exit counts
  exits?: Record<string, number[]>
  // instance id -> the cell its runtime-metrics lines name; absent means it logged none
  cells?: Record<string, string>
  director503?: number[][]
  concurrency?: number[][]
  descriptorStatus?: number
  loggingStatus?: number
}

function fakeGoogle(fake: Fake) {
  const requests: { url: URL; body: string | null }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? init.body : null
    requests.push({ url, body })
    if (url.pathname.includes('/metricDescriptors/')) {
      return new Response('{}', { status: fake.descriptorStatus ?? 200 })
    }
    if (url.hostname === 'logging.googleapis.com') {
      if (fake.loggingStatus) return new Response('{}', { status: fake.loggingStatus })
      const filter = String(JSON.parse(body ?? '{}').filter ?? '')
      const instanceId = /instance_id="([0-9]+)"/.exec(filter)?.[1] ?? ''
      const cellId = fake.cells?.[instanceId]
      return Response.json({ entries: cellId ? [{ jsonPayload: { cellId } }] : [] })
    }
    const filter = url.searchParams.get('filter') ?? ''
    if (filter.includes(CELL_PROCESS_EXIT_METRIC)) {
      return Response.json({
        timeSeries: Object.entries(fake.exits ?? {}).map(([instanceId, values]) => ({
          resource: { labels: { instance_id: instanceId } },
          points: points(values)
        }))
      })
    }
    const series = filter.includes('request_count')
      ? (fake.director503 ?? []).map((values) => points(values))
      : (fake.concurrency ?? [[1]]).map((values) => points(values, 'doubleValue'))
    return Response.json({ timeSeries: series.map((entry) => ({ points: entry })) })
  }
  return { fetchImpl, requests }
}

function reader(fetchImpl: typeof fetch) {
  return createPreDrainHardRuleReader(environment, async () => 'token', scope, {
    fetchImpl,
    now: () => now
  })
}

describe('pre-drain hard rule reader', () => {
  it('takes the busiest 503 minute and the highest concurrency p99', async () => {
    const { fetchImpl } = fakeGoogle({
      director503: [[40, 620, 55]],
      concurrency: [[12.5, 66.8]]
    })
    await expect(reader(fetchImpl)()).resolves.toEqual({
      cellProcessExits: 0,
      unattributedExitInstances: [],
      director503PeakPerMinute: 620,
      directorConcurrencyP99: 66.8
    })
  })

  it('reads an empty concurrency series as unknown, not calm', async () => {
    const { fetchImpl } = fakeGoogle({ concurrency: [] })
    await expect(reader(fetchImpl)()).resolves.toMatchObject({ directorConcurrencyP99: null })
  })

  it('ignores the target cell rolling the fix for its own crashes', async () => {
    const { fetchImpl } = fakeGoogle({
      exits: { '2525': [3, 4] },
      cells: { '2525': 'production-gce-c25' }
    })
    await expect(reader(fetchImpl)()).resolves.toMatchObject({
      cellProcessExits: 0,
      unattributedExitInstances: []
    })
  })

  it('counts an exit on another cell that takes placements', async () => {
    const { fetchImpl } = fakeGoogle({
      exits: { '2626': [1], '2525': [5] },
      cells: { '2626': 'production-gce-c26', '2525': 'production-gce-c25' }
    })
    await expect(reader(fetchImpl)()).resolves.toMatchObject({
      cellProcessExits: 1,
      unattributedExitInstances: []
    })
  })

  it('ignores an existing-only legacy cell', async () => {
    const { fetchImpl } = fakeGoogle({
      exits: { '505': [15] },
      cells: { '505': 'production-gce-c5' }
    })
    await expect(reader(fetchImpl)()).resolves.toMatchObject({
      cellProcessExits: 0,
      unattributedExitInstances: []
    })
  })

  it('reports an exit it cannot name a cell for as unattributed', async () => {
    const { fetchImpl } = fakeGoogle({ exits: { '999': [1] } })
    await expect(reader(fetchImpl)()).resolves.toMatchObject({
      cellProcessExits: 0,
      unattributedExitInstances: ['999']
    })
  })

  it('fails the read, rather than guessing, when the cell lookup itself fails', async () => {
    const { fetchImpl } = fakeGoogle({ exits: { '2626': [1] }, loggingStatus: 403 })
    await expect(reader(fetchImpl)()).rejects.toThrow('Google telemetry returned 403')
  })

  it('names an instance from its own runtime-metrics lines, once', async () => {
    const { fetchImpl, requests } = fakeGoogle({
      exits: { '2626': [1] },
      cells: { '2626': 'production-gce-c26' }
    })
    const read = reader(fetchImpl)
    await read()
    await read()
    const lookups = requests.filter(({ url }) => url.hostname === 'logging.googleapis.com')
    expect(lookups).toHaveLength(1)
    const body = JSON.parse(lookups[0]?.body ?? '{}')
    expect(body.filter).toContain('resource.labels.instance_id="2626"')
    expect(body.filter).toContain('jsonPayload.event="orca_relay_runtime_metrics"')
    expect(body.filter).toContain(
      `timestamp>="${new Date(now - INSTANCE_CELL_LOOKBACK_MS).toISOString()}"`
    )
    expect(body.orderBy).toBe('timestamp desc')
  })

  it('asks again next sample for an instance it could not name', async () => {
    const fake: Fake = { exits: { '2626': [1] } }
    const { fetchImpl, requests } = fakeGoogle(fake)
    const read = reader(fetchImpl)
    await expect(read()).resolves.toMatchObject({ unattributedExitInstances: ['2626'] })
    fake.cells = { '2626': 'production-gce-c26' }
    await expect(read()).resolves.toMatchObject({
      cellProcessExits: 1,
      unattributedExitInstances: []
    })
    expect(requests.filter(({ url }) => url.hostname === 'logging.googleapis.com'))
      .toHaveLength(2)
  })

  it('aligns each read per minute over its own lookback on the director service', async () => {
    const { fetchImpl, requests } = fakeGoogle({})
    await reader(fetchImpl)()
    const reads = requests.map(({ url }) => url).filter((url) => url.pathname.endsWith('/timeSeries'))
    expect(reads).toHaveLength(3)
    const byMetric = (needle: string): URL => {
      const url = reads.find((entry) => entry.searchParams.get('filter')?.includes(needle))
      if (!url) throw new Error(`no read for ${needle}`)
      return url
    }
    const exits = byMetric(CELL_PROCESS_EXIT_METRIC)
    expect(exits.searchParams.get('interval.startTime')).toBe('2026-10-01T11:50:00.000Z')
    expect(exits.searchParams.get('aggregation.groupByFields'))
      .toBe('resource.label."instance_id"')
    const director503 = byMetric('run.googleapis.com/request_count')
    expect(director503.searchParams.get('filter')).toContain('metric.label."response_code"="503"')
    expect(director503.searchParams.get('filter')).toContain(
      `resource.label."service_name"="${environment.directorService}"`
    )
    expect(director503.searchParams.get('aggregation.perSeriesAligner')).toBe('ALIGN_DELTA')
    expect(director503.searchParams.get('aggregation.crossSeriesReducer')).toBe('REDUCE_SUM')
    const concurrency = byMetric('max_request_concurrencies')
    expect(concurrency.searchParams.get('interval.startTime')).toBe('2026-10-01T11:56:00.000Z')
    expect(concurrency.searchParams.get('aggregation.perSeriesAligner'))
      .toBe('ALIGN_PERCENTILE_99')
    for (const url of reads) {
      expect(url.searchParams.get('aggregation.alignmentPeriod')).toBe('60s')
      expect(url.searchParams.get('interval.endTime')).toBe('2026-10-01T12:00:00.000Z')
    }
  })

  // Why: a deleted or renamed log metric reads as an empty series, which is zero exits forever.
  it('refuses to count exits from a metric that does not exist', async () => {
    const { fetchImpl } = fakeGoogle({ descriptorStatus: 404 })
    await expect(reader(fetchImpl)()).rejects.toThrow('Google telemetry returned 404')
  })
})
