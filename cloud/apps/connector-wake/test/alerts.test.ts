// The wake alerts against a stubbed Analytics Engine, GraphQL API and wake Worker.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluate, type WakeAlertsEnv } from '../src/alerts'

const healthy = { socket_open: 400, refuse_401: 3, refuse_country: 0, keys_unavailable: 0, admin_failures: 0, wakes: 1000, wake_no_socket: 10, wake_error: 0, events: 3000, reconnects: 380, reconnects_late: 5, drops: 60, replaced: 50 }
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

// The SQL answers per minute before the run's schedule: this run judges minutes 2-16 against 17-31.
type Minutes = Record<number, Partial<Row>>
const minutes = (now: Partial<Row>, before: Partial<Row>): Minutes => ({ 2: { ...healthy, ...now }, 17: { ...healthy, ...before } })
const sqlAnswer = (byMinute: Minutes) => Response.json({ data: Object.entries(byMinute).map(([ago, row]) => ({ ago: String(ago), ...row })) })

// ALERT_STATE as a Worker sees it, kept across runs by passing the same one.
function memoryKv(): KVNamespace & { puts: number } {
  const store = new Map<string, string>()
  const kv = {
    puts: 0,
    get: async (key: string, type?: string) => {
      const value = store.get(key)
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => {
      kv.puts++
      store.set(key, value)
    }
  }
  return kv as unknown as KVNamespace & { puts: number }
}
const at = (hour: number, minute: number) => Date.UTC(2026, 10, 22, hour, minute)

type Run = { fired: string[]; posts: string[]; graphqlScript?: string; graphqlVars?: Record<string, string>; sql?: string }
type Opts = { at?: number; env?: Partial<WakeAlertsEnv>; minutes?: Minutes; kv?: KVNamespace; sqlStatus?: number; cfErrors?: number | 'fail'; cfBody?: unknown; hookStatus?: number }
async function run(now: Partial<Row>, before: Partial<Row> = {}, opts: Opts = {}): Promise<Run> {
  const result: Run = { fired: [], posts: [] }
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url === env.ALERT_WEBHOOK_URL) {
      result.posts.push(JSON.parse(String(init?.body)).text)
      return new Response('ok', { status: opts.hookStatus ?? 200 })
    }
    if (url === 'https://wake.test/v1/connector/wake') { return new Response(null, { status: 401 }) }
    if (url === 'https://wake.test/__health/object') { return Response.json({ ok: true }) }
    if (url.endsWith('/graphql')) {
      const body = JSON.parse(String(init?.body))
      result.graphqlScript = body.variables.script
      result.graphqlVars = body.variables
      if (opts.cfErrors === 'fail') { return new Response('no', { status: 500 }) }
      if (opts.cfBody !== undefined) { return Response.json(opts.cfBody) }
      const w0 = opts.cfErrors ? [{ sum: { requests: 1000 - opts.cfErrors }, dimensions: { status: 'success' } }, { sum: { requests: opts.cfErrors }, dimensions: { status: 'scriptThrewException' } }] : []
      return Response.json({ data: { viewer: { accounts: [{ w0, w1: [] }] } } })
    }
    result.sql = String(init?.body)
    if (opts.sqlStatus) { return new Response('no', { status: opts.sqlStatus }) }
    return sqlAnswer(opts.minutes ?? minutes(now, before))
  })
  result.fired = await evaluate({ ...env, ALERT_STATE: opts.kv, ...opts.env }, opts.at ?? at(10, 17))
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

  it('fires auth-refusals once, again only after an hour, and resolves once', async () => {
    const kv = memoryKv()
    const refused = { refuse_401: 10 }
    expect((await run(refused, {}, { kv, at: at(10, 17) })).fired[0]).toMatch(/^FIRING auth-refusals:/)
    expect((await run(refused, refused, { kv, at: at(10, 22) })).fired).toEqual([])
    expect((await run(refused, refused, { kv, at: at(11, 12) })).fired).toEqual([])
    expect((await run(refused, refused, { kv, at: at(11, 17) })).fired[0]).toMatch(/^STILL FIRING auth-refusals:/)
    expect((await run(refused, refused, { kv, at: at(11, 22) })).fired).toEqual([])
    expect((await run({}, refused, { kv, at: at(11, 27) })).fired).toEqual(['RESOLVED auth-refusals'])
    expect((await run({}, {}, { kv, at: at(11, 32) })).fired).toEqual([])
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
    expect((await run({ drops: 600, reconnects: 200 })).fired[0]).toMatch(/^FIRING reconnect-surge/)
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

  it('leaves out hibernated socket events that throw, and still counts Worker and object fetch/RPC errors', async () => {
    const ns = 'c9b66c56'
    const doGroup = (type: string, status: string, requests: number) => ({ sum: { requests }, dimensions: { namespaceId: ns, type, status } })
    let graphql: { query: string; variables: Record<string, unknown> } | undefined
    const answer = (o0: unknown[]) => async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === env.ALERT_WEBHOOK_URL || url.endsWith('/v1/connector/wake')) { return new Response(null, { status: url.endsWith('/wake') ? 401 : 200 }) }
      if (url.endsWith('/__health/object')) { return Response.json({ ok: true }) }
      if (url.endsWith('/graphql')) {
        graphql = JSON.parse(String(init?.body))
        const w0 = [{ sum: { requests: 1000 }, dimensions: { status: 'success' } }]
        return Response.json({ data: { viewer: { accounts: [{ w0, w1: [], o0, o1: [] }] } } })
      }
      return sqlAnswer(minutes({}, {}))
    }
    const retirement = [doGroup('hibernation', 'success', 800), doGroup('hibernation', 'scriptThrewException', 200)]
    vi.stubGlobal('fetch', answer(retirement))
    expect(await evaluate({ ...env, CF_DO_NAMESPACE_IDS: ns }, at(10, 17))).toEqual([])
    // Cloudflare filters to the configured namespaces, so other objects never fill the group limit.
    expect(graphql?.variables.ns).toEqual([ns])
    expect(graphql?.query).toContain('durableObjectsInvocationsAdaptiveGroups(limit:200,filter:{namespaceId_in:$ns,')
    vi.stubGlobal('fetch', answer([...retirement, doGroup('jsrpc', 'scriptThrewException', 30), doGroup('http', 'internalError', 30)]))
    expect(await evaluate({ ...env, CF_DO_NAMESPACE_IDS: ns }, at(10, 17))).toEqual(['FIRING cloudflare-errors: Worker/Durable Object errors 60 = 2.9% of 2060 invocations in 15 min'])
  })

  it('alerts when metrics are unreadable or the canary object fails', async () => {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input)
      if (url === env.ALERT_WEBHOOK_URL) { return new Response('ok') }
      if (url.endsWith('/v1/connector/wake')) { return new Response(null, { status: 401 }) }
      if (url.endsWith('/__health/object')) { return Response.json({ ok: false }, { status: 503 }) }
      return new Response('no', { status: 500 })
    })
    const fired = await evaluate(env, Date.UTC(2026, 10, 22, 10, 17), async () => {})
    expect(fired).toEqual([
      'FIRING object-probe: object health check got 503, expected 200 (retried after 10 s; first try: object health check got 503, expected 200)',
      'alerts cannot read metrics: analytics query failed: 500'
    ])
  })

  it('retries one canary miss after 10 s and stays quiet when the retry answers', async () => {
    let objectCalls = 0
    const waits: number[] = []
    const posts: string[] = []
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === env.ALERT_WEBHOOK_URL) {
        posts.push(JSON.parse(String(init?.body)).text)
        return new Response('ok')
      }
      if (url.endsWith('/v1/connector/wake')) { return new Response(null, { status: 401 }) }
      if (url.endsWith('/__health/object')) {
        objectCalls++
        return objectCalls === 1 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true })
      }
      if (url.endsWith('/graphql')) { return Response.json({ data: { viewer: { accounts: [{ w0: [], w1: [] }] } } }) }
      return sqlAnswer(minutes({}, {}))
    })
    const fired = await evaluate(env, Date.UTC(2026, 10, 22, 10, 17), async (ms) => { waits.push(ms) })
    expect(fired).toEqual([])
    expect(posts).toEqual([])
    expect(objectCalls).toBe(2)
    expect(waits).toEqual([10_000])
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
  it('reads both windows from one per-minute query, anchored to the scheduled time', async () => {
    const atSec = at(10, 17) / 1000
    const r = await run({})
    expect(r.sql).toMatch(/GROUP BY ago/)
    expect(r.sql).toContain(`intDiv(${atSec} - toUInt32(timestamp), 60) AS ago`)
    expect(r.sql).toContain(`timestamp > toDateTime(${atSec - 32 * 60}) AND timestamp <= toDateTime(${atSec})`)
  })

  it('anchors the Cloudflare error windows to the scheduled time too', async () => {
    const r = await run({}, {}, { at: at(10, 17) })
    expect(r.graphqlVars).toMatchObject({
      s0: new Date(at(10, 0)).toISOString(),
      e0: new Date(at(10, 15)).toISOString(),
      s1: new Date(at(9, 45)).toISOString(),
      e1: new Date(at(10, 0)).toISOString()
    })
  })

  it('still fires once when the run at the transition was skipped', async () => {
    const kv = memoryKv()
    expect((await run({}, {}, { kv, at: at(10, 12) })).fired).toEqual([])
    // No run at 10:17; by 10:22 the failed wakes fill this window and part of the one before.
    expect((await run({ wake_error: 3 }, { wake_error: 2 }, { kv, at: at(10, 22) })).fired).toEqual(['FIRING wake-errors: 3 wakes failed in 15 min, of 1000 wakes'])
    expect((await run({ wake_error: 3 }, { wake_error: 3 }, { kv, at: at(10, 27) })).fired).toEqual([])
  })

  it('keeps firing state across a run whose metrics read failed', async () => {
    const kv = memoryKv()
    expect((await run({ wake_error: 3 }, {}, { kv, at: at(10, 17) })).fired[0]).toMatch(/^FIRING wake-errors/)
    expect((await run({}, {}, { kv, at: at(10, 22), sqlStatus: 500 })).fired).toEqual(['alerts cannot read metrics: analytics query failed: 500'])
    expect((await run({ wake_error: 3 }, { wake_error: 3 }, { kv, at: at(10, 27) })).fired).toEqual([])
    // A rule that starts while a read failed fires on the next readable run.
    expect((await run({ wake_error: 3, admin_failures: 3 }, { wake_error: 3 }, { kv, at: at(10, 32) })).fired).toEqual(['FIRING admin-failures: 3 failed admin calls in 15 min'])
  })

  it('reads an empty result as zero counts, so silent still fires on a window with no rows', async () => {
    expect((await run({}, {}, { minutes: {} })).fired).toEqual([])
    expect((await run({}, {}, { minutes: { 20: healthy } })).fired).toEqual(['FIRING silent: no wake events in 15 min'])
  })

  it('keeps cloudflare-errors firing while Cloudflare analytics cannot be read, and resolves on a readable zero', async () => {
    const kv = memoryKv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await run({}, {}, { kv, at: at(10, 17), cfErrors: 100 })).fired[0]).toMatch(/^FIRING cloudflare-errors/)
    expect((await run({}, {}, { kv, at: at(10, 22), cfErrors: 'fail' })).fired).toEqual([])
    expect((await run({}, {}, { kv, at: at(11, 2), cfErrors: 'fail' })).fired).toEqual(['alerts cannot read Cloudflare analytics: cloudflare analytics query failed: 500'])
    expect((await run({}, {}, { kv, at: at(11, 7), cfErrors: 0 })).fired).toEqual(['RESOLVED cloudflare-errors'])
    vi.restoreAllMocks()
  })

  it('logs every failed Cloudflare read with bounded, scrubbed GraphQL errors, and posts the text hourly', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const echoed = `account acct rejected key token ${'x'.repeat(1000)}`
    const cfBody = { data: null, errors: [{ message: echoed, path: ['viewer', 'accounts'], extensions: { code: 'authz' } }] }
    const quiet = await run({}, {}, { at: at(10, 22), cfBody })
    expect(quiet.posts).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0][0])
    expect(line).toMatch(/^cloudflare analytics read failed \{/)
    expect(line).not.toMatch(/acct|token/)
    const logged = JSON.parse(line.slice(line.indexOf('{')))
    expect(logged).toMatchObject({ reason: 'cloudflare analytics query returned errors', script: 'orca-connector-wake', status: 200, errors: [{ path: ['viewer', 'accounts'], code: 'authz' }] })
    expect(logged.errors[0].message).toMatch(/^account \[redacted\] rejected key \[redacted\] x+…$/)
    expect(logged.errors[0].message).toHaveLength(200)

    const hourly = await run({}, {}, { at: at(11, 2), cfBody })
    expect(hourly.fired).toHaveLength(1)
    expect(hourly.fired[0]).toMatch(/^alerts cannot read Cloudflare analytics: cloudflare analytics query returned errors: authz: account \[redacted\] rejected key \[redacted\] x+…$/)
    expect(hourly.posts[0]).not.toMatch(/acct|token/)

    // Malformed errors still report the original failure.
    const malformed = { data: { viewer: { accounts: [] } }, errors: [null, 'x', { extensions: { code: 'timeout' } }] }
    expect((await run({}, {}, { at: at(11, 2), cfBody: malformed })).fired).toEqual(['alerts cannot read Cloudflare analytics: cloudflare analytics query returned errors: timeout'])
    expect((await run({}, {}, { at: at(11, 2), cfBody: { errors: { message: 'not a list' } } })).fired).toEqual(['alerts cannot read Cloudflare analytics: cloudflare analytics query returned errors'])
    vi.restoreAllMocks()
  })

  it('posts a FIRING or RESOLVED again next run when the webhook rejected it', async () => {
    const kv = memoryKv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await run({ wake_error: 3 }, {}, { kv, at: at(10, 17), hookStatus: 500 })).fired[0]).toMatch(/^FIRING wake-errors/)
    expect((await run({ wake_error: 3 }, { wake_error: 3 }, { kv, at: at(10, 22) })).fired[0]).toMatch(/^FIRING wake-errors/)
    expect((await run({ wake_error: 3 }, { wake_error: 3 }, { kv, at: at(10, 27) })).fired).toEqual([])
    expect((await run({}, { wake_error: 3 }, { kv, at: at(10, 32), hookStatus: 500 })).fired).toEqual(['RESOLVED wake-errors'])
    expect((await run({}, { wake_error: 3 }, { kv, at: at(10, 37) })).fired).toEqual(['RESOLVED wake-errors'])
    expect((await run({}, {}, { kv, at: at(10, 42) })).fired).toEqual([])
    vi.restoreAllMocks()
  })

  it('keeps silent firing while there are still no events, and resolves only when they return', async () => {
    const kv = memoryKv()
    const quiet = { socket_open: 0, refuse_401: 0, wakes: 0, wake_no_socket: 0, events: 0 }
    expect((await run({}, {}, { kv, at: at(10, 17), minutes: { 20: healthy } })).fired).toEqual(['FIRING silent: no wake events in 15 min'])
    // Both windows empty now: the start is old news, but it is still silent.
    expect((await run({}, {}, { kv, at: at(10, 52), minutes: { 2: quiet, 17: quiet } })).fired).toEqual([])
    expect((await run({}, {}, { kv, at: at(11, 17), minutes: { 2: quiet, 17: quiet } })).fired).toEqual(['STILL FIRING silent: no wake events in 15 min'])
    // Events return (a few, not a reconnect surge).
    expect((await run({}, {}, { kv, at: at(11, 22), minutes: { 2: { ...quiet, socket_open: 10, events: 30 }, 17: quiet } })).fired).toEqual(['RESOLVED silent'])
  })

  it('retries a rejected silent start through an outage that empties both windows', async () => {
    const kv = memoryKv()
    const quiet = { socket_open: 0, refuse_401: 0, wakes: 0, wake_no_socket: 0, events: 0 }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The last events are 31 min old: just inside the window before.
    expect((await run({}, {}, { kv, at: at(10, 17), minutes: { 31: healthy }, hookStatus: 500 })).fired).toEqual(['FIRING silent: no wake events in 15 min'])
    // Five minutes on they are outside both windows, but it is still silent and was never announced.
    expect((await run({}, {}, { kv, at: at(10, 22), minutes: { 2: quiet, 17: quiet } })).fired).toEqual(['FIRING silent: no wake events in 15 min'])
    expect((await run({}, {}, { kv, at: at(10, 27), minutes: { 2: quiet, 17: quiet } })).fired).toEqual([])
    vi.restoreAllMocks()
  })

  it('posts on every breaching run when no ALERT_STATE is bound', async () => {
    expect((await run({ wake_error: 3 }, { wake_error: 3 })).fired[0]).toMatch(/^FIRING wake-errors/)
  })

  it('never evaluates the rules ALERTS_OFF names, and says which names match no rule', async () => {
    const quiet = { socket_open: 0, refuse_401: 0, wakes: 0, wake_no_socket: 0, events: 0 }
    const stopped: Minutes = { 2: quiet, 20: healthy }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await run({}, {}, { minutes: stopped, env: { ALERTS_OFF: 'silent' } })).fired).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect((await run({ admin_failures: 3 }, {}, { env: { ALERTS_OFF: ' silent , nonesuch' } })).fired[0]).toMatch(/^FIRING admin-failures/)
    expect(warn).toHaveBeenCalledWith('connector-wake alerts: ALERTS_OFF names no rule: nonesuch')
    const r = await run({}, {}, { env: { ALERTS_OFF: 'cloudflare-errors' } })
    expect(r.graphqlScript).toBeUndefined()
    warn.mockRestore()
  })
  // The production windows of 2026-11-24 the old rule (socket opens >= 3x) fired on: two Durable
  // Object retirement waves, 1006 drops every desktop was back from within seconds.
  const waves = {
    '15:40 UTC': [
      { socket_open: 869, reconnects: 802, reconnects_late: 20, drops: 445, replaced: 100, wake_error: 0 },
      { socket_open: 242, reconnects: 192, reconnects_late: 8, drops: 66, replaced: 108, wake_error: 0 }
    ],
    '21:30 UTC': [
      { socket_open: 679, reconnects: 464, reconnects_late: 9, drops: 279, replaced: 56, wake_error: 0 },
      { socket_open: 173, reconnects: 151, reconnects_late: 6, drops: 34, replaced: 104, wake_error: 0 }
    ]
  }
  const surge = (r: Run) => r.fired.filter((text) => text.includes('reconnect-surge'))
  const prod = { env: { RECONNECT_SURGE_MIN: '50' } }

  it('stays quiet on an object retirement wave: drops 7x, every desktop back within seconds', async () => {
    for (const [now, before] of Object.values(waves)) {
      expect(surge(await run(now, before, prod))).toEqual([])
    }
  })

  it('still fires when the same drops are not followed by reconnects, or wakes fail', async () => {
    for (const [now, before] of Object.values(waves)) {
      // The Worker or objects broken: the desktops fell back to long-poll instead of reconnecting.
      expect(surge(await run({ ...now, socket_open: 50, reconnects: 50 }, before, prod))).toEqual([
        expect.stringMatching(/^FIRING reconnect-surge: drops \d+, reconnects 50 /)
      ])
      expect(surge(await run({ ...now, wake_error: 3 }, before, prod))).toHaveLength(1)
    }
    // Extra reconnects under half the extra drops (445 - 66 = 379) fire; half does not.
    const [now, before] = waves['15:40 UTC']
    expect(surge(await run({ ...now, reconnects: 192 + 189 }, before, prod))).toHaveLength(1)
    expect(surge(await run({ ...now, reconnects: 192 + 190 }, before, prod))).toEqual([])
  })

  it('fires when sockets come back late (30 s - 1 h after their drop), whatever the drops', async () => {
    const [now, before] = waves['21:30 UTC']
    expect(surge(await run({ ...now, reconnects_late: 50 }, before, prod))).toHaveLength(1)
    // 3x the previous window and at least RECONNECT_SURGE_MIN.
    expect(surge(await run({ ...now, reconnects_late: 49 }, before, prod))).toEqual([])
    expect(surge(await run({ ...now, reconnects_late: 60 }, { ...before, reconnects_late: 21 }, prod))).toEqual([])
  })

  it('counts neither graceful closes nor late gaps from hosts away for hours, in its SQL', async () => {
    const { sql } = await run({})
    expect(sql).toContain("blob1 = 'socket_close' AND blob2 NOT IN ('1000', '1001', '1005', '4409')) AS drops")
    expect(sql).toContain("blob1 = 'reconnect_gap' AND double1 > 30000 AND double1 <= 3600000) AS reconnects_late")
    expect(sql).toContain("sumIf(_sample_interval, blob1 = 'reconnect_gap') AS reconnects")
    expect(sql).toContain("sumIf(_sample_interval, blob1 = 'socket_open' AND blob2 = 'replaced') AS replaced")
  })

  it('a widening or narrowing of the switch is quiet: new hosts connect, removed ones close 1005', async () => {
    // 08:10 UTC: opens 64 vs 1 as the first hosts joined. 19:40 UTC: 1005 closes from the 500 -> 300
    // per mille narrowing are not drops.
    expect(surge(await run({ socket_open: 64, reconnects: 6, reconnects_late: 0, drops: 6, replaced: 0 }, { socket_open: 1, reconnects: 1, reconnects_late: 0, drops: 1, replaced: 0 }, prod))).toEqual([])
    expect(surge(await run({ socket_open: 317, reconnects: 315, reconnects_late: 14, drops: 69, replaced: 211 }, { socket_open: 603, reconnects: 571, reconnects_late: 13, drops: 71, replaced: 493 }, prod))).toEqual([])
  })
  it('fires on a regional loss nobody reconnects from, even under the fleet`s steady reconnects', async () => {
    // One region loses 200 sockets and none come back; everyone else reconnects as usual (3-8x the
    // drops), so total reconnects stay at their baseline.
    const baselines = [
      waves['15:40 UTC'][1],
      waves['21:30 UTC'][1],
      // 19:40 UTC: reconnects 8x the drops.
      { socket_open: 603, reconnects: 571, reconnects_late: 13, drops: 71, replaced: 104, wake_error: 0 }
    ]
    for (const before of baselines) {
      expect(surge(await run({ ...before, drops: before.drops + 200 }, before, prod))).toEqual([
        expect.stringMatching(/^FIRING reconnect-surge: drops \d+, reconnects \d+ /)
      ])
    }
  })

  it('fires on a stuck-but-open socket storm: terminated after missed keepalives, redialed at once, replaced 4409', async () => {
    // Every desktop redials within 1 s of terminating its silent socket, so the gaps are fast and the
    // old socket closes 4409 (not a drop): only the replacements surge.
    const [, before] = waves['15:40 UTC']
    const storm = { ...before, socket_open: before.socket_open + 600, reconnects: before.reconnects + 600, replaced: before.replaced + 600 }
    expect(surge(await run(storm, before, prod))).toEqual([expect.stringMatching(/replaced sockets 708,/)])
    // 2026-11-24 17:50 UTC: replacements 453 vs 132, redials within 1.5 s, 1006 closes flat.
    expect(surge(await run(
      { socket_open: 583, reconnects: 543, reconnects_late: 14, drops: 71, replaced: 453, wake_error: 0 },
      { socket_open: 357, reconnects: 321, reconnects_late: 16, drops: 132, replaced: 132, wake_error: 0 },
      prod
    ))).toHaveLength(1)
  })

  it('never fires on an empty window, even with RECONNECT_SURGE_MIN 0', async () => {
    const empty = { socket_open: 0, reconnects: 0, reconnects_late: 0, drops: 0, replaced: 0, wake_error: 0 }
    expect(surge(await run(empty, empty, { env: { RECONNECT_SURGE_MIN: '0' } }))).toEqual([])
  })

  it('never pages auth-refusals on 2 refusals in a small window, at any share', async () => {
    // A window holds up to 4 of the alerts' own probe refusals; these are 2 beyond them.
    const two = { refuse_401: 6 }
    // 36 upgrades: 5.6% refused, which the share rule alone fired on at MIN_VOLUME 20.
    expect((await run({ ...two, socket_open: 30 })).fired).toEqual([])
    // 306 upgrades: 0.65%, still only 2 refusals.
    expect((await run({ ...two, socket_open: 300 })).fired).toEqual([])
    // 5 refusals: the share rule above the upgrade floor, the low-volume rule below it.
    expect((await run({ refuse_401: 9, socket_open: 300 })).fired).toEqual(['FIRING auth-refusals: 401 refusals 5 = 1.62% of upgrades'])
    expect((await run({ refuse_401: 9, socket_open: 100 })).fired).toEqual(['FIRING auth-refusals-low-volume: 401 refusals 5 in 15 min at low volume (109 upgrades)'])
  })

  it('takes its upgrade floor from AUTH_MIN_UPGRADES, never below MIN_VOLUME', async () => {
    const refused = { refuse_401: 9, socket_open: 100 }
    expect((await run(refused, {}, { env: { AUTH_MIN_UPGRADES: '50' } })).fired[0]).toMatch(/^FIRING auth-refusals: /)
    expect((await run(refused, {}, { env: { AUTH_MIN_UPGRADES: '50', MIN_VOLUME: '150' } })).fired[0]).toMatch(/^FIRING auth-refusals-low-volume: /)
  })
})
