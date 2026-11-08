// The absolute-count alert rules (fire below MIN_VOLUME) and the synthetic edge probe, with a
// stubbed Analytics Engine, webhook and edge.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_SUCCESS_LABELS, evaluate } from '../src/alerts'
import { probeEdge } from '../src/alerts-probe'

const quiet = { phone_open: 20, control_active: 20, refuse_4401: 0, refuse_busy: 0, control_close: 5, db_ops: 0, db_failures: 0, admin_failures: 0, db_p95_ms: 0, events: 60 }
const env = { ACCOUNT_ID: 'a', DATASET: 'd', ENVIRONMENT: 'test', AE_READ_TOKEN: 't', ALERT_WEBHOOK_URL: 'https://hook.invalid', MIN_VOLUME: '200' }
const PROBE = 'https://edge.invalid'
type Row = typeof quiet
type EdgeAnswer = number | 'network' | 'hang'

function stub(now: Partial<Row>, before: Partial<Row> = {}, edge: EdgeAnswer = 401) {
  const posts: string[] = []
  const probes: RequestInit[] = []
  const sqls: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === env.ALERT_WEBHOOK_URL) {
      posts.push(JSON.parse(String(init.body)).text)
      return new Response('ok')
    }
    if (url === `${PROBE}/__health/object`) {
      if (edge === 'network') { throw new TypeError('connection refused') }
      return Response.json({ ok: true })
    }
    if (url === `${PROBE}/v1/host/control`) {
      probes.push(init)
      if (edge === 'network') { throw new TypeError('connection refused') }
      if (edge === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }
      return new Response(null, { status: edge })
    }
    const sql = String(init.body)
    sqls.push(sql)
    const row = sql.includes("INTERVAL '32' MINUTE") ? { ...quiet, ...before } : { ...quiet, ...now }
    return Response.json({ data: [sql.includes('db_p95_ms') && !sql.includes('sumIf') ? { db_p95_ms: row.db_p95_ms } : row] })
  })
  return { posts, probes, sqls }
}

const at17 = Date.UTC(2026, 10, 6, 10, 17)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('absolute-count rules', () => {
  it('stay quiet on a healthy low-volume edge', async () => {
    stub({})
    expect(await evaluate(env, at17)).toEqual([])
  })

  it('count every admin label outside the success list as a failure', async () => {
    const { sqls } = stub({})
    await evaluate(env, at17)
    const sql = sqls.find((s) => s.includes('admin_failures')) ?? ''
    for (const label of ADMIN_SUCCESS_LABELS) { expect(sql).toContain(`'${label}'`) }
    expect(sql).toMatch(/blob1 = 'admin' AND blob2 NOT IN \(/)
    expect(ADMIN_SUCCESS_LABELS).toEqual(expect.arrayContaining(['drain:drained', 'drain:idle', 'erase:mismatch', 'export:busy']))
    expect(ADMIN_SUCCESS_LABELS).not.toContain('assign:stale')
  })

  it('fire on 3 admin failures at any volume, once', async () => {
    const { posts } = stub({ admin_failures: 3 })
    const fired = await evaluate(env, at17)
    expect(fired).toEqual(['FIRING admin-failures: 3 failed admin calls in 15 min'])
    expect(posts).toHaveLength(1)
    stub({ admin_failures: 3 }, { admin_failures: 4 })
    expect(await evaluate(env, at17)).toEqual([])
    stub({ admin_failures: 2 })
    expect(await evaluate(env, at17)).toEqual([])
  })

  it('fire on 5 4401s below MIN_VOLUME; the share rule owns higher volume', async () => {
    stub({ refuse_4401: 5 })
    expect(await evaluate(env, at17)).toEqual(['FIRING auth-refusals-low-volume: 4401 refusals 5 in 15 min at low volume (40 hellos)'])
    stub({ refuse_4401: 4 })
    expect(await evaluate(env, at17)).toEqual([])
    stub({ refuse_4401: 5, phone_open: 1000, control_active: 1000 })
    expect(await evaluate(env, at17)).toEqual([])
  })
})

describe('edge probe', () => {
  it('is skipped without EDGE_PROBE_URL', async () => {
    const { probes } = stub({})
    await evaluate(env, at17)
    expect(probes).toHaveLength(0)
  })

  it('passes on 401 to an unauthenticated websocket upgrade', async () => {
    const { probes } = stub({})
    expect(await evaluate({ ...env, EDGE_PROBE_URL: `${PROBE}/` }, at17)).toEqual([])
    expect(probes).toHaveLength(1)
    const headers = new Headers(probes[0].headers)
    expect(headers.get('upgrade')).toBe('websocket')
    expect(headers.get('authorization')).toBeNull()
  })

  it('alerts with the status on any other answer', async () => {
    const { posts } = stub({}, {}, 500)
    const fired = await evaluate({ ...env, EDGE_PROBE_URL: PROBE }, at17)
    expect(fired).toEqual(['FIRING edge-probe: unauthenticated control upgrade got 500, expected 401'])
    expect(posts).toEqual(['[relay-edge test] FIRING edge-probe: unauthenticated control upgrade got 500, expected 401'])
  })

  it('alerts on a network error, and still when metrics are unreadable', async () => {
    stub({}, {}, 'network')
    expect(await probeEdge(PROBE)).toBe('unauthenticated control upgrade failed: connection refused')
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === env.ALERT_WEBHOOK_URL) { return new Response('ok') }
      if (url.startsWith(PROBE)) { throw new TypeError('connection refused') }
      return new Response('no', { status: 403 })
    })
    const fired = await evaluate({ ...env, EDGE_PROBE_URL: PROBE }, at17)
    expect(fired[0]).toContain('FIRING edge-probe')
    expect(fired[1]).toContain('FIRING object-probe')
    expect(fired[2]).toContain('cannot read metrics')
  })

  it('alerts after 5 s without an answer', async () => {
    vi.useFakeTimers()
    stub({}, {}, 'hang')
    const result = probeEdge(PROBE)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await result).toBe('unauthenticated control upgrade timed out after 5000 ms')
  })

  it('alerts on a slow 401', async () => {
    stub({})
    let t = 0
    expect(await probeEdge(PROBE, () => (t += 5_001))).toBe('unauthenticated control upgrade took 5001 ms')
  })
})
