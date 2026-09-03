import { describe, expect, it } from 'vitest'
import { RELAY_METRICS, readMonitoringSnapshot } from './monitoring-snapshot.js'
import type { GcloudClient } from './gcloud-client.js'
import { RELAY_OPS_ENVIRONMENTS } from './environment-config.js'

const gcloud: GcloudClient = {
  accessToken: async () => 'a'.repeat(40)
}

function distribution(at: string, mean: number | undefined, count = 1) {
  return {
    interval: { endTime: at },
    value: { distributionValue: { count, ...(mean === undefined ? {} : { mean }) } }
  }
}

describe('readMonitoringSnapshot', () => {
  it('aggregates gauge series per minute and distribution deltas by count', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/alertPolicies')) {
        return Response.json({ alertPolicies: [] })
      }
      const filter = url.searchParams.get('filter') ?? ''
      if (filter.includes('orca_relay_controls')) {
        return Response.json({ timeSeries: [
          {
            metric: { labels: { cell_id: 'production-gce-c1' } },
            resource: { type: 'gce_instance', labels: { instance_id: 'one' } },
            points: [
              distribution('2026-07-15T12:00:10Z', 1),
              distribution('2026-07-15T12:00:50Z', 2)
            ]
          },
          {
            metric: { labels: { cell_id: 'production-gce-c1' } },
            resource: { type: 'gce_instance', labels: { instance_id: 'two' } },
            points: [distribution('2026-07-15T12:00:20Z', 3)]
          },
          {
            metric: { labels: { cell_id: 'production-gce-c1' } },
            resource: { type: 'gce_instance', labels: { instance_id: 'stale' } },
            points: [distribution('2026-07-15T11:59:20Z', 100)]
          }
        ] })
      }
      if (filter.includes('orca_relay_forwarded_bytes')) {
        return Response.json({ timeSeries: [{
          metric: { labels: { cell_id: 'production-gce-c1' } },
          resource: { type: 'gce_instance', labels: { instance_id: 'one' } },
          points: [distribution('2026-07-15T12:00:20Z', 10, 4)]
        }] })
      }
      return Response.json({ timeSeries: [] })
    }

    const result = await readMonitoringSnapshot(RELAY_OPS_ENVIRONMENTS.production, gcloud, {
      now: new Date('2026-07-15T12:01:00Z'),
      windowMinutes: 30,
      fetchImpl
    })

    expect(result.warnings).toEqual([])
    expect(result.metrics.controls.points).toEqual([
      { at: '2026-07-15T11:59:00.000Z', value: 100 },
      { at: '2026-07-15T12:00:00.000Z', value: 5 }
    ])
    expect(result.metrics.controls.latestByCell).toEqual({ 'production-gce-c1': 5 })
    expect(result.metrics.forwarded_bytes.latest).toBe(40)
    expect(result.metrics.postgres_retries.available).toBe(true)
    expect(Object.keys(result.metrics)).toHaveLength(RELAY_METRICS.length)
  })

  it('degrades safely when credentials are unavailable', async () => {
    const unavailable: GcloudClient = {
      accessToken: async () => { throw new Error('sensitive context') }
    }
    const result = await readMonitoringSnapshot(RELAY_OPS_ENVIRONMENTS.production, unavailable)
    expect(result.warnings).toEqual([
      'Cloud Monitoring credentials are unavailable. Run gcloud auth login.'
    ])
    expect(result.metrics.postgres_retries.available).toBe(false)
    expect(JSON.stringify(result)).not.toContain('sensitive context')
  })
})
