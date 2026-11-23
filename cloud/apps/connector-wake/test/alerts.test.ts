// The wake alerts against a stubbed Analytics Engine, GraphQL API and wake Worker.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluate, type WakeAlertsEnv } from '../src/alerts'

const healthy = { socket_open: 400, refuse_401: 3, refuse_country: 0, keys_unavailable: 0, admin_failures: 0, wakes: 1000, wake_no_socket: 10, wake_error: 0, events: 3000 }
type Row = typeof healthy
const env: WakeAlertsEnv = {
  ACCOUNT_ID: 'acct',
  DATASET: 'orca_connector_wake_test',
  ENVIRONMENT: 'test',
  AE_READ_TOKEN: 'token',
  ALERT_WEBHOOK_URL: 'https://hook.test/post',
  MIN_VOLUME: '20',
  EDGE_PROBE_URL: 'https://wake.test',
  CF_GRAPHQL_USE_AE_TOKEN: '1'
}

// The SQL answers per minute ago. This run judges minutes 2-16 against 17-31; the previous run (5 min
// ago) judged 7-21 against 22-36. So `now` sits only in this run's window, `before` in the minutes
// both runs share (the previous run's own window), and healthy traffic precedes it.
type Minutes = Record<number, Partial<Row>>
const minutes = (now: Partial<Row>, before: Partial<Row>): Minutes => ({ 2: { ...healthy, ...now }, 17: { ...healthy, ...before }, 32: healthy })
const sqlAnswer = (byMinute: Minutes) => Response.json({ data: Object.entries(byMinute).map(([ago, row]) => ({ ago: String(ago), ...row })) })

type Run = { fired: string[]; posts: string[]; graphqlScript?: string; sql?: string }
async function run(now: Partial<Row>, before: Partial<Row> = {}, opts: { minute?: number; env?: Partial<WakeAlertsEnv>; minutes?: Minutes } = {}): Promise<Run> {
  const result: Run = { fired: [], posts: [] }
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url === env.ALERT_WEBHOOK_URL) {
      result.posts.push(JSON.parse(String(init?.body)).text)
      return new Response('ok')
    }
    if (url === 'https://wake.test/v1/connector/wake') { return new Response(null, { status: 401 }) }
    if (url === 'https://wake.test/__health/object') { return Response.json({ ok: true }) }
    if (url.endsWith('/graphql')) {
      result.graphqlScript = JSON.parse(String(init?.body)).variables.script
      return Response.json({ data: { viewer: { accounts: [{ w0: [], w1: [] }] } } })
    }
    result.sql = String(init?.body)
    return sqlAnswer(opts.minutes ?? minutes(now, before))
  })
  result.fired = await evaluate({ ...env, ...opts.env }, Date.UTC(2026, 10, 22, 10, opts.minute ?? 17))
  return result
}

afterEach(() => vi.unstubAllGlobals())

describe('wake alerts', () => {
  it('stays quiet when healthy, and posts nothing', async () => {
    const r = await run({})
    expect(r.fired).toEqual([])
    expect(r.posts).toEqual([])
  })

  it('never counts its own probe refusals as auth refusals, even with one more from cron jitter', async () => {
    // A 15 min window holds 3 probes, or 4 when a run lands late.
    expect((await run({ socket_open: 20, refuse_401: 4 })).fired).toEqual([])
    expect((await run({ socket_open: 5, refuse_401: 8 })).fired).toEqual([])
    const r = await run({ socket_open: 5, refuse_401: 9 })
    expect(r.fired).toEqual(['FIRING auth-refusals-low-volume: 401 refusals 5 in 15 min at low volume (14 upgrades)'])
    expect(r.posts[0]).toMatch(/^\[connector-wake test\] FIRING auth-refusals-low-volume/)
  })

  it('fires auth-refusals above 0.5% of upgrades once, then hourly', async () => {
    expect((await run({ refuse_401: 10 })).fired[0]).toMatch(/^FIRING auth-refusals:/)
    expect((await run({ refuse_401: 10 }, { refuse_401: 10 })).fired).toEqual([])
    expect((await run({ refuse_401: 10 }, { refuse_401: 10 }, { minute: 2 })).fired[0]).toMatch(/^STILL FIRING auth-refusals:/)
  })

  it('fires the no-socket share above NO_SOCKET_PCT of wakes, at NO_SOCKET_MIN wakes', async () => {
    expect((await run({ wake_no_socket: 60 })).fired[0]).toMatch(/^FIRING no-socket-share/)
    expect((await run({ wakes: 40, wake_no_socket: 40 })).fired).toEqual([])
  })

  it('fires on failed wakes, which Cloudflare error counts never see', async () => {
    expect((await run({ wake_error: 2 })).fired).toEqual([])
    expect((await run({ wake_error: 3 })).fired).toEqual(['FIRING wake-errors: 3 wakes failed in 15 min, of 1000 wakes'])
  })

  it('fires on a reconnect surge, admin failures, and silence after traffic', async () => {
    expect((await run({ socket_open: 1300 })).fired[0]).toMatch(/^FIRING reconnect-surge/)
    expect((await run({ admin_failures: 3 })).fired[0]).toMatch(/^FIRING admin-failures/)
    const silent = { socket_open: 0, refuse_401: 3, wakes: 0, wake_no_socket: 0, events: 0 }
    expect((await run(silent)).fired).toEqual(['FIRING silent: no wake events in 15 min'])
    expect((await run(silent, silent)).fired).toEqual([])
  })

  it('reads Cloudflare errors for the wake Worker, never the relay edge', async () => {
    expect((await run({})).graphqlScript).toBe('orca-connector-wake')
    expect((await run({}, {}, { env: { CF_SCRIPT_NAME: 'orca-connector-wake-staging' } })).graphqlScript).toBe('orca-connector-wake-staging')
  })

  it('fires cloudflare-errors from the GraphQL counts', async () => {
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === env.ALERT_WEBHOOK_URL || url.endsWith('/v1/connector/wake')) { return new Response(null, { status: url.endsWith('/wake') ? 401 : 200 }) }
      if (url.endsWith('/__health/object')) { return Response.json({ ok: true }) }
      if (url.endsWith('/graphql')) {
        const errors = [{ sum: { requests: 900 }, dimensions: { status: 'success' } }, { sum: { requests: 100 }, dimensions: { status: 'scriptThrewException' } }]
        return Response.json({ data: { viewer: { accounts: [{ w0: errors, w1: [] }] } } })
      }
      return sqlAnswer(minutes({}, {}))
    })
    const fired = await evaluate(env, Date.UTC(2026, 10, 22, 10, 17))
    expect(fired).toEqual(['FIRING cloudflare-errors: Worker/Durable Object errors 100 = 10.0% of 1000 invocations in 15 min'])
  })

  it('alerts when metrics are unreadable or the canary object fails', async () => {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input)
      if (url === env.ALERT_WEBHOOK_URL) { return new Response('ok') }
      if (url.endsWith('/v1/connector/wake')) { return new Response(null, { status: 401 }) }
      if (url.endsWith('/__health/object')) { return Response.json({ ok: false }, { status: 503 }) }
      return new Response('no', { status: 500 })
    })
    const fired = await evaluate(env, Date.UTC(2026, 10, 22, 10, 17))
    expect(fired).toEqual(['FIRING object-probe: object health check got 503, expected 200', 'alerts cannot read metrics: analytics query failed: 500'])
  })

  it('alerts when the wake upgrade is not refused 401', async () => {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input)
      if (url === env.ALERT_WEBHOOK_URL) { return new Response('ok') }
      if (url.endsWith('/v1/connector/wake')) { return new Response(null, { status: 404 }) }
      if (url.endsWith('/__health/object')) { return Response.json({ ok: true }) }
      return sqlAnswer(minutes({}, {}))
    })
    const fired = await evaluate({ ...env, CF_GRAPHQL_USE_AE_TOKEN: undefined }, Date.UTC(2026, 10, 22, 10, 17))
    expect(fired).toEqual(['FIRING edge-probe: unauthenticated wake upgrade got 404, expected 401'])
  })
  // Traffic stops; each run is 5 min later, so the last busy minute is 5 min older each time.
  it('fires silent once when traffic stops, then only hourly while it holds, then resolves', async () => {
    const quiet = { socket_open: 0, refuse_401: 0, wakes: 0, wake_no_socket: 0, events: 0 }
    const lastBusyAgo = (ago: number): Minutes => ({ 2: quiet, [ago]: healthy })
    expect((await run({}, {}, { minutes: lastBusyAgo(20) })).fired).toEqual(['FIRING silent: no wake events in 15 min'])
    expect((await run({}, {}, { minutes: lastBusyAgo(25) })).fired).toEqual([])
    expect((await run({}, {}, { minutes: lastBusyAgo(30) })).fired).toEqual([])
    expect((await run({}, {}, { minutes: lastBusyAgo(25), minute: 2 })).fired).toEqual(['STILL FIRING silent: no wake events in 15 min'])
    expect((await run({}, {}, { minutes: lastBusyAgo(35) })).fired).toEqual([])
  })

  it('fires a rule without a prior window once, not on every run its breach stays in the window', async () => {
    // A burst of failed wakes 3 min ago stays in this run's window for three runs.
    expect((await run({}, {}, { minutes: { 3: { ...healthy, wake_error: 3 }, 17: healthy, 32: healthy } })).fired).toEqual(['FIRING wake-errors: 3 wakes failed in 15 min, of 1000 wakes'])
    expect((await run({}, {}, { minutes: { 8: { ...healthy, wake_error: 3 }, 17: healthy, 32: healthy } })).fired).toEqual([])
    expect((await run({}, {}, { minutes: { 13: { ...healthy, wake_error: 3 }, 17: healthy, 32: healthy } })).fired).toEqual([])
  })

  it('reads every window from one per-minute query, anchored to the scheduled time', async () => {
    const at = Date.UTC(2026, 10, 22, 10, 17) / 1000
    const r = await run({})
    expect(r.sql).toMatch(/GROUP BY ago/)
    expect(r.sql).toContain(`intDiv(${at} - toUInt32(timestamp), 60) AS ago`)
    expect(r.sql).toContain(`timestamp > toDateTime(${at - 37 * 60}) AND timestamp <= toDateTime(${at})`)
  })

  it('never evaluates the rules ALERTS_OFF names, and says which names match no rule', async () => {
    const quiet = { socket_open: 0, refuse_401: 0, wakes: 0, wake_no_socket: 0, events: 0 }
    const stopped: Minutes = { 2: quiet, 20: healthy }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await run({}, {}, { minutes: stopped, env: { ALERTS_OFF: 'silent' } })).fired).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect((await run({ admin_failures: 3 }, {}, { env: { ALERTS_OFF: ' silent , nonesuch' } })).fired[0]).toMatch(/^FIRING admin-failures/)
    expect(warn).toHaveBeenCalledWith('connector-wake alerts: ALERTS_OFF names no rule: nonesuch')
    warn.mockRestore()
  })
})
