import { describe, expect, it } from 'vitest'
import { RELAY_OPS_ENVIRONMENTS } from './environment-config.js'
import type { GcloudClient } from './gcloud-client.js'
import { effectiveAdmissionState } from './incident-selector.js'
import { INCIDENT_MONITOR_THRESHOLDS } from './incident-monitor.js'
import {
  directorSignals,
  GOOGLE_METRICS,
  readGoogleMetric,
  readGoogleMetricWithEmptyRetry,
  relayFiveMinuteDeltaSignal
} from './incident-monitor-sources.js'

const now = Date.parse('2026-07-28T10:00:00.000Z')
const startAt = new Date(now - 5 * 60_000).toISOString()
const endAt = new Date(now).toISOString()
const productionCells = RELAY_OPS_ENVIRONMENTS.production.cells.map(
  ({ cellId }) => cellId
)

describe('incident monitor sources', () => {
  it('uses legacy booleans only at selector generation zero', () => {
    const membership = {
      existingOnly: ['c1'],
      migrationOnly: [],
      general: ['c2']
    }
    expect(
      effectiveAdmissionState({ generation: 0, membership }, true, 'c1')
    ).toBe('general')
    expect(
      effectiveAdmissionState({ generation: 1, membership }, true, 'c1')
    ).toBe('existing-only')
  })

  it('sums DELTA metrics across the window and scopes every target exactly', async () => {
    const filters: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      filters.push(url.searchParams.get('filter') ?? '')
      return Response.json({
        timeSeries: [
          {
            points: [
              {
                interval: { endTime: new Date(now - 120_000).toISOString() },
                value: { int64Value: '2' }
              },
              {
                interval: { endTime: new Date(now - 60_000).toISOString() },
                value: { int64Value: '3' }
              }
            ]
          }
        ]
      })
    }
    const environment = RELAY_OPS_ENVIRONMENTS.production
    const directorErrors = GOOGLE_METRICS.find(
      (definition) => definition.signal === 'director.errors'
    )!
    const deadlocks = GOOGLE_METRICS.find(
      (definition) => definition.signal === 'cloud_sql.deadlocks'
    )!
    await expect(
      readGoogleMetric(
        environment,
        directorErrors,
        'secret-access-token',
        startAt,
        endAt,
        fetchImpl
      )
    ).resolves.toEqual({
      value: 5,
      observedAt: new Date(now - 60_000).toISOString()
    })
    await readGoogleMetric(
      environment,
      deadlocks,
      'secret-access-token',
      startAt,
      endAt,
      fetchImpl
    )
    expect(filters[0]).toContain(
      'resource.label."service_name"="orca-cloud-relay"'
    )
    expect(filters[0]).toContain('metric.label."response_code"!="503"')
    expect(filters[1]).toContain(
      'resource.label."database_id"="onorca-cloud:orca-cloud-auth-db"'
    )
  })

  it('zero-fills an expired sparse lock-wait point', async () => {
    let pointAt = now - INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs
    const fetchImpl: typeof fetch = async () => Response.json({
      timeSeries: [{
        points: [{
          interval: { endTime: new Date(pointAt).toISOString() },
          value: { int64Value: '1' }
        }]
      }]
    })
    const definition = GOOGLE_METRICS.find(
      ({ signal }) => signal === 'cloud_sql.lock_waits'
    )!
    await expect(readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      fetchImpl
    )).resolves.toEqual({
      value: 1,
      observedAt: new Date(pointAt).toISOString()
    })
    await expect(readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      fetchImpl,
      () => now + 3_000
    )).resolves.toEqual({
      value: 1,
      observedAt: new Date(pointAt).toISOString()
    })
    pointAt--
    await expect(readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      fetchImpl
    )).resolves.toEqual({ value: 0, observedAt: endAt })
  })

  it('freshens a sparse zero without masking a recent nonzero lock wait', async () => {
    let value = 0
    const pointAt = now - INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs
    const readAt = now + 11_879
    const fetchImpl: typeof fetch = async () => Response.json({
      timeSeries: [{
        points: [{
          interval: { endTime: new Date(pointAt).toISOString() },
          value: { int64Value: String(value) }
        }]
      }]
    })
    const definition = GOOGLE_METRICS.find(
      ({ signal }) => signal === 'cloud_sql.lock_waits'
    )!

    const sparseZero = await readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      fetchImpl,
      () => readAt
    )
    expect(sparseZero).toEqual({
      value: 0,
      observedAt: new Date(readAt).toISOString()
    })
    expect(readAt - pointAt).toBe(191_879)
    expect(readAt - Date.parse(sparseZero!.observedAt)).toBe(0)

    value = 20
    await expect(readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      fetchImpl,
      () => readAt
    )).resolves.toEqual({
      value: 20,
      observedAt: new Date(pointAt).toISOString()
    })
  })

  it('preserves a recent nonzero lock wait across staggered series', async () => {
    const nonzeroAt = now - 179_000
    const zeroAt = now - 178_000
    const definition = GOOGLE_METRICS.find(
      ({ signal }) => signal === 'cloud_sql.lock_waits'
    )!
    const metric = await readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      async () => Response.json({
        timeSeries: [
          {
            points: [{
              interval: { endTime: new Date(nonzeroAt).toISOString() },
              value: { int64Value: '7' }
            }]
          },
          {
            points: [{
              interval: { endTime: new Date(zeroAt).toISOString() },
              value: { int64Value: '0' }
            }]
          }
        ]
      })
    )

    expect(metric).toEqual({
      value: 7,
      observedAt: new Date(nonzeroAt).toISOString()
    })

    await expect(readGoogleMetric(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      async () => Response.json({
        timeSeries: [{
          points: [
            {
              interval: { endTime: new Date(nonzeroAt).toISOString() },
              value: { int64Value: '7' }
            },
            {
              interval: { endTime: new Date(zeroAt).toISOString() },
              value: { int64Value: '0' }
            }
          ]
        }]
      })
    )).resolves.toEqual({ value: 0, observedAt: endAt })
  })

  it('retries an empty required metric without weakening its value', async () => {
    let calls = 0
    const waits: number[] = []
    const definition = GOOGLE_METRICS.find(
      ({ signal }) => signal === 'cloud_sql.cpu'
    )!
    await expect(readGoogleMetricWithEmptyRetry(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      async () => Response.json(calls++ === 0
        ? { timeSeries: [] }
        : {
            timeSeries: [{
              points: [{
                interval: { endTime: new Date(now - 60_000).toISOString() },
                value: { doubleValue: 0.81 }
              }]
            }]
          }),
      () => now,
      async (ms) => { waits.push(ms) }
    )).resolves.toEqual({
      value: 0.81,
      observedAt: new Date(now - 60_000).toISOString()
    })
    expect(calls).toBe(2)
    expect(waits).toEqual([2_000])
  })

  it('still reports a required metric missing after bounded retries', async () => {
    let calls = 0
    const waits: number[] = []
    const definition = GOOGLE_METRICS.find(
      ({ signal }) => signal === 'director.concurrency'
    )!
    await expect(readGoogleMetricWithEmptyRetry(
      RELAY_OPS_ENVIRONMENTS.production,
      definition,
      'secret-access-token',
      startAt,
      endAt,
      async () => {
        calls++
        return Response.json({ timeSeries: [] })
      },
      () => now,
      async (ms) => { waits.push(ms) }
    )).resolves.toBeNull()
    expect(calls).toBe(3)
    expect(waits).toEqual([2_000, 2_000])
  })

  it('timestamps sparse retry aggregates at query completion', () => {
    expect(relayFiveMinuteDeltaSignal({
      available: true,
      points: [
        { at: new Date(now - 22 * 60_000).toISOString(), value: 7 },
        { at: new Date(now - 4 * 60_000).toISOString(), value: 2 }
      ]
    }, endAt)).toEqual({ value: 2, observedAt: endAt })
    expect(relayFiveMinuteDeltaSignal({
      available: true,
      points: [{ at: new Date(now - 22 * 60_000).toISOString(), value: 7 }]
    }, endAt)).toEqual({ value: 0, observedAt: endAt })
    expect(relayFiveMinuteDeltaSignal({
      available: false,
      points: []
    }, endAt)).toBeNull()
  })

  it('aggregates admin state without returning tokens or response identities', async () => {
    const identityToken = 'secret.header.signature'
    const sensitiveIdentity = 'user@example.test'
    const gcloud: GcloudClient = {
      accessToken: async () => 'unused',
      identityToken: async () => identityToken
    }
    let activeRequests = 0
    let maximumActiveRequests = 0
    let requestCount = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestCount++
      activeRequests++
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${identityToken}`
      )
      const body = JSON.parse(String(init?.body)) as {
        cellId?: string
        sourceCellId?: string
        targetCellId?: string
      }
      await Promise.resolve()
      activeRequests--
      if (!body.cellId && !body.sourceCellId) {
        return Response.json({
          selector: {
            generation: 1,
            membership: {
              existingOnly: productionCells.slice(2),
              migrationOnly: ['production-gce-c2'],
              general: ['production-gce-c1']
            }
          }
        })
      }
      if (body.cellId) {
        return Response.json({
          status: {
            // Selector-era monitoring must ignore this legacy compatibility bit.
            enabled: body.cellId !== 'production-gce-c1',
            connectionCapacity: {
              hardCap: body.cellId === 'production-gce-c1' ? 1_000 : 600
            },
            runtime: {
              lastHeartbeatAt: now - 1_000,
              heartbeatFresh: true
            },
            userId: sensitiveIdentity
          }
        })
      }
      return Response.json({
        blocked: 0,
        blockedExpiredUnregistered:
          body.sourceCellId === 'production-gce-c1' &&
          body.targetCellId === 'production-gce-c2'
            ? 1
            : 0,
        registeredTargetInactive: 0,
        userId: sensitiveIdentity
      })
    }
    const result = await directorSignals(
      'production',
      {
        generation: 1,
        membership: {
          existingOnly: productionCells.slice(2),
          migrationOnly: ['production-gce-c2'],
          general: ['production-gce-c1']
        }
      },
      gcloud,
      now,
      fetchImpl
    )
    expect(requestCount).toBe(productionCells.length * 2)
    expect(maximumActiveRequests).toBe(1)
    expect(
      result.source.signals['cell.production-gce-c1.migration_blocked']
    ).toMatchObject({ value: 1 })
    expect(result.cells.find((cell) => cell.cellId === 'production-gce-c1')).toMatchObject({
      expectedAdmissionState: 'general'
    })
    expect(
      result.source.signals['cell.production-gce-c1.admission_state']
    ).toMatchObject({ value: 2 })
    expect(
      result.source.signals['cell.production-gce-c1.connection_hard_cap']
    ).toMatchObject({ value: 1_000 })
    expect(
      result.source.signals['cell.production-gce-c2.admission_state']
    ).toMatchObject({ value: 1 })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(identityToken)
    expect(serialized).not.toContain(sensitiveIdentity)
  })
})
