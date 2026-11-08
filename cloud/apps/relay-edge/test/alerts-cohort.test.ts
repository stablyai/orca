// Alert rules that scale with the cohort: configurable MIN_VOLUME, the reconnect surge, Cloudflare
// GraphQL errors and the canary object probe. Analytics Engine, GraphQL, edge and webhook stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluate } from '../src/alerts'
import { cloudflareQuery } from '../src/alerts-cloudflare'
import { probeObject } from '../src/alerts-probe'

const quiet = { phone_open: 20, control_active: 20, reconnects: 20, refuse_4401: 0, refuse_busy: 0, control_close: 5, db_ops: 0, db_failures: 0, admin_failures: 0, db_p95_ms: 0, events: 60 }
const env = { ACCOUNT_ID: 'acct', DATASET: 'd', ENVIRONMENT: 'test', AE_READ_TOKEN: 't', ALERT_WEBHOOK_URL: 'https://hook.invalid' }
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
const PROBE = 'https://edge.invalid'
type Row = typeof quiet
type Group = { sum: { requests: number }; dimensions: { status: string; namespaceId?: string } }
type Graph = { w0?: Group[]; w1?: Group[]; o0?: Group[]; o1?: Group[] } | 'errors' | 'down'

const at17 = Date.UTC(2026, 10, 6, 10, 17)
const at02 = Date.UTC(2026, 10, 6, 10, 2)
const group = (status: string, requests: number, namespaceId?: string): Group => ({ sum: { requests }, dimensions: { status, ...(namespaceId ? { namespaceId } : {}) } })

function stub(now: Partial<Row>, before: Partial<Row> = {}, graph: Graph = {}) {
  const posts: string[] = []
  const graphql: { query: string; variables: Record<string, string> }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url === env.ALERT_WEBHOOK_URL) {
      posts.push(JSON.parse(String(init.body)).text)
      return new Response('ok')
    }
    if (url === GRAPHQL) {
      graphql.push(JSON.parse(String(init.body)))
      if (graph === 'down') { return new Response('no', { status: 403 }) }
      if (graph === 'errors') { return Response.json({ data: null, errors: [{ message: 'unknown field' }] }) }
      return Response.json({ data: { viewer: { accounts: [graph] } }, errors: null })
    }
    const sql = String(init.body)
    const row = sql.includes("INTERVAL '32' MINUTE") ? { ...quiet, ...before } : { ...quiet, ...now }
    return Response.json({ data: [sql.includes('db_p95_ms') && !sql.includes('sumIf') ? { db_p95_ms: row.db_p95_ms } : row] })
  })
  return { posts, graphql }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MIN_VOLUME', () => {
  it('scales the share rules to the cohort', async () => {
    stub({ refuse_4401: 1 })
    expect(await evaluate(env, at17)).toEqual([])
    stub({ refuse_4401: 1 })
    expect(await evaluate({ ...env, MIN_VOLUME: '20' }, at17)).toEqual(['FIRING auth-refusals: 4401 refusals 1 = 2.50% of hellos'])
  })
})

describe('reconnect surge', () => {
  it('fires at 3x the previous window once above the floor', async () => {
    stub({ reconnects: 60 }, { reconnects: 20 })
    expect(await evaluate(env, at17)).toEqual(['FIRING reconnect-surge: control hellos 60 in 15 min, at least 3x the previous window'])
  })

  it('stays quiet below the floor or below 3x', async () => {
    stub({ reconnects: 49 }, { reconnects: 0 })
    expect(await evaluate(env, at17)).toEqual([])
    stub({ reconnects: 100 }, { reconnects: 40 })
    expect(await evaluate(env, at17)).toEqual([])
  })

  it('takes its floor from RECONNECT_SURGE_MIN', async () => {
    stub({ reconnects: 6 }, { reconnects: 2 })
    expect(await evaluate({ ...env, RECONNECT_SURGE_MIN: '5' }, at17)).toHaveLength(1)
  })
})

describe('cloudflare errors', () => {
  it('is skipped without CF_GRAPHQL_TOKEN', async () => {
    const { graphql } = stub({})
    expect(await evaluate(env, at17)).toEqual([])
    expect(graphql).toHaveLength(0)
  })

  it('fires above 20 errors and 1% of invocations, for the edge script', async () => {
    const { graphql, posts } = stub({}, {}, { w0: [group('success', 2000), group('clientDisconnected', 500), group('scriptThrewException', 30)], w1: [group('success', 2000)] })
    const fired = await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g' }, at17)
    expect(fired).toEqual(['FIRING cloudflare-errors: Worker/Durable Object errors 30 = 1.2% of 2530 invocations in 15 min'])
    expect(graphql[0].variables.script).toBe('orca-relay-edge')
    expect(graphql[0].variables.a).toBe('acct')
    expect(graphql[0].query).not.toContain('durableObjects')
    expect(posts[0]).not.toMatch(/acct|orca-relay-edge/)
  })

  it('stays quiet under either threshold, and honours the env thresholds', async () => {
    stub({}, {}, { w0: [group('success', 20000), group('exceededResources', 30)] })
    expect(await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g' }, at17)).toEqual([])
    stub({}, {}, { w0: [group('success', 100), group('internalError', 20)] })
    expect(await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g' }, at17)).toEqual([])
    stub({}, {}, { w0: [group('success', 100), group('internalError', 20)] })
    expect(await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g', CF_ERRORS_MIN: '10' }, at17)).toHaveLength(1)
  })

  it('counts only the configured Durable Object namespaces', async () => {
    const { graphql } = stub({}, {}, { w0: [group('success', 100)], o0: [group('error', 50, 'ns-edge'), group('error', 500, 'ns-other'), group('success', 900, 'ns-edge')] })
    const fired = await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g', CF_DO_NAMESPACE_IDS: 'ns-edge' }, at17)
    expect(fired).toEqual(['FIRING cloudflare-errors: Worker/Durable Object errors 50 = 4.8% of 1050 invocations in 15 min'])
    expect(graphql[0].query).toContain('durableObjectsInvocationsAdaptiveGroups')
  })

  it('reports an unreadable API hourly only, and keeps the other rules running', async () => {
    stub({ admin_failures: 3 }, {}, 'down')
    expect(await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g' }, at17)).toEqual(['FIRING admin-failures: 3 failed admin calls in 15 min'])
    stub({}, {}, 'errors')
    expect(await evaluate({ ...env, CF_GRAPHQL_TOKEN: 'g' }, at02)).toEqual(['alerts cannot read Cloudflare analytics: cloudflare analytics query returned errors'])
  })

  it('keeps the query small: one call, both windows, documented fields only', () => {
    expect(cloudflareQuery(false)).toMatch(/w0:workersInvocationsAdaptive\(limit:50,filter:\{scriptName:\$script,datetime_geq:\$s0,datetime_lt:\$e0\}\)\{sum\{requests\} dimensions\{status\}\}/)
    expect(cloudflareQuery(true)).toContain('o1:durableObjectsInvocationsAdaptiveGroups')
  })
})

describe('object probe', () => {
  const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', async () => Response.json(body, { status }))

  it('passes on 200 {ok:true} and alerts on 503 or a wrong body', async () => {
    answer(200, { ok: true })
    expect(await probeObject(PROBE)).toBeNull()
    answer(503, { ok: false })
    expect(await probeObject(PROBE)).toBe('object health check got 503, expected 200')
    answer(200, { ok: false })
    expect(await probeObject(PROBE)).toBe('object health check got 200, expected 200')
  })

  it('alerts over 2 s', async () => {
    answer(200, { ok: true })
    let t = 0
    expect(await probeObject(PROBE, () => (t += 2_001))).toBe('object health check took 2001 ms')
  })

  it('runs with the edge probe each cycle and fires as object-probe', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url === env.ALERT_WEBHOOK_URL) { return new Response('ok') }
      if (url === `${PROBE}/v1/host/control`) { return new Response(null, { status: 401 }) }
      if (url === `${PROBE}/__health/object`) { return Response.json({ ok: false }, { status: 503 }) }
      const sql = String(init.body)
      return Response.json({ data: [sql.includes('sumIf') ? quiet : { db_p95_ms: 0 }] })
    })
    expect(await evaluate({ ...env, EDGE_PROBE_URL: PROBE }, at17)).toEqual(['FIRING object-probe: object health check got 503, expected 200'])
  })
})
