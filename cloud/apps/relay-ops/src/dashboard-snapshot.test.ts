import { describe, expect, it, vi } from 'vitest'
import { DashboardSnapshotCache } from './dashboard-snapshot.js'
import type { DashboardSnapshot } from './dashboard-snapshot.js'
import type { GcloudClient } from './gcloud-client.js'

const gcloud: GcloudClient = { accessToken: async () => 'a'.repeat(40) }

function snapshot(kind: 'good' | 'unavailable'): DashboardSnapshot {
  const good = kind === 'good'
  return {
    generatedAt: '2026-07-15T12:00:00.000Z',
    resources: {
      director: good ? {} : null,
      auth: good ? {} : null,
      sql: good ? {} : null,
      cells: [{ targetSize: good ? 1 : null }]
    },
    monitoring: {
      warnings: good
        ? []
        : ['Cloud Monitoring credentials are unavailable. Run gcloud auth login.']
    },
    summary: { observedConnections: good ? 7 : 0 },
    warnings: good ? [] : ['Google Cloud credentials are unavailable. Run gcloud auth login.'],
    stale: false,
    staleReason: null
  } as unknown as DashboardSnapshot
}

describe('DashboardSnapshotCache', () => {
  it('releases expired windows as the dashboard continues reading other windows', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cache = new DashboardSnapshotCache(gcloud, 30_000, async () => snapshot('good'))
    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        await cache.read('production', 30 + cycle)
        now += 30_001
        await cache.read('production', 360)
        const retained: unknown = Reflect.get(cache, 'entries')
        if (!(retained instanceof Map)) throw new Error('snapshot entries unavailable')
        expect([...retained.keys()]).toEqual(['production:360'])
      }
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps the last good view when a later credential refresh fails', async () => {
    let calls = 0
    const cache = new DashboardSnapshotCache(gcloud, 0, async () => {
      calls += 1
      return snapshot(calls === 1 ? 'good' : 'unavailable')
    })

    const first = await cache.read('production', 30)
    const second = await cache.read('production', 31)

    expect(first.stale).toBe(false)
    expect(second.stale).toBe(true)
    expect(second.summary.observedConnections).toBe(7)
    expect(second.staleReason).toContain('credentials')
  })

  it('keeps the last good view when a later collector throws', async () => {
    let calls = 0
    const cache = new DashboardSnapshotCache(gcloud, 0, async () => {
      calls += 1
      if (calls > 1) throw new Error('sensitive collector context')
      return snapshot('good')
    })

    await cache.read('production', 30)
    const second = await cache.read('production', 31)

    expect(second.stale).toBe(true)
    expect(second.summary.observedConnections).toBe(7)
    expect(JSON.stringify(second)).not.toContain('sensitive collector context')
  })
})
