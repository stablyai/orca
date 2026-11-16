// Internal-only per-session CPU, fair-use report, and its operator gate.
import { describe, expect, it } from 'vitest'
import { FAIR_USE_THRESHOLD, fairUseReport, recordSessionEnd, sweepSessionCpu } from '../src/session-cpu'
import type { SandboxRow } from '../src/store'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'
import { createFakeD1 } from './d1-fake'
import { createHarness } from './harness'

const OPERATOR = 'o'.repeat(40)
const MIN = 60_000
const create = { workspaceId: 'ws-1', machineSize: 'standard' }

async function operator(h: Awaited<ReturnType<typeof createHarness>>, method: string, path: string) {
  const response = await h.send(
    new Request(`https://sandbox.test${path}`, { method, headers: { authorization: `Bearer ${OPERATOR}` } })
  )
  return { status: response.status, body: (await response.json()) as any }
}

function client(answer: (url: URL, method: string) => Response) {
  return createVercelSandboxApi({
    token: 'vercel_test_token',
    teamId: 'team_orca',
    projectId: 'prj_orca',
    fetch: async (input, init) => answer(new URL(String(input)), init?.method ?? 'GET')
  })
}

const stoppedSession = {
  id: 'sess_1',
  status: 'stopped',
  startedAt: 1000,
  timeout: 1_800_000,
  memory: 16384,
  vcpus: 8,
  region: 'iad1',
  duration: 600_000,
  stoppedAt: 601_000,
  activeCpuDurationMs: 123_456
}

describe('Vercel session usage mapping', () => {
  it('maps activeCpuDurationMs, duration, vcpus and memory from GET session', async () => {
    let seen: URL | null = null
    const api = client((url) => ((seen = url), Response.json({ session: stoppedSession, routes: [] })))
    expect(await api.getSessionUsage!('sess_1')).toEqual({
      sessionId: 'sess_1',
      status: 'stopped',
      activeCpuMs: 123_456,
      durationMs: 600_000,
      vcpus: 8,
      memoryMb: 16384,
      stoppedAt: 601_000
    })
    expect(seen!.pathname).toBe('/api/v2/sandboxes/sessions/sess_1')
  })

  it('a running session has no CPU yet; a forgotten one is null', async () => {
    const running = client(() => Response.json({ session: { id: 's', status: 'running', timeout: 1, vcpus: 8 } }))
    expect(await running.getSessionUsage!('s')).toMatchObject({ activeCpuMs: null, vcpus: 8, durationMs: null })
    const gone = client(() => Response.json({ error: { code: 'not_found' } }, { status: 404 }))
    expect(await gone.getSessionUsage!('s')).toBeNull()
  })

  it('reads usage off the stop response, and an unreadable session never fails the stop', async () => {
    const withSession = client(() => Response.json({ session: stoppedSession, snapshot: { id: 'snap_1', status: 'created', sourceSessionId: 'sess_1' } }))
    expect(await withSession.stopSession('sess_1')).toMatchObject({ snapshotId: 'snap_1', usage: { activeCpuMs: 123_456 } })
    const odd = client(() => Response.json({ session: { id: 7 }, snapshot: { id: 'snap_1', status: 'created', sourceSessionId: 'sess_1' } }))
    expect(await odd.stopSession('sess_1')).toEqual({ snapshotId: 'snap_1', usage: null })
  })
})

function row(overrides: Partial<SandboxRow> = {}): SandboxRow {
  return {
    id: 'sbx_1',
    account_id: 'user:alice',
    user_id: 'alice',
    session_id: 'sess_1',
    session_started_at: 1_000,
    ...overrides
  } as SandboxRow
}

describe('session CPU storage', () => {
  it('is idempotent per session and the first recorded CPU wins', async () => {
    const { db, raw } = createFakeD1()
    await recordSessionEnd(db, row(), 61_000, null, 61_000)
    await recordSessionEnd(db, row(), 99_000, null, 99_000)
    const usage = { sessionId: 'sess_1', status: 'stopped' as const, activeCpuMs: 30_000, durationMs: 60_000, vcpus: 8, memoryMb: 16384, stoppedAt: 61_000 }
    await recordSessionEnd(db, row(), 99_000, usage, 100_000)
    await recordSessionEnd(db, row(), 99_000, { ...usage, activeCpuMs: 1 }, 200_000)
    const rows = raw.prepare('SELECT * FROM session_cpu').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ session_id: 'sess_1', sandbox_id: 'sbx_1', account_id: 'user:alice', user_id: 'alice', ended_at: 61_000, active_cpu_ms: 30_000, wall_ms: 60_000, vcpus: 8, memory_mb: 16384, fetched_at: 100_000 })
  })

  it('never throws, even when D1 does', async () => {
    const broken = { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database
    await expect(recordSessionEnd(broken, row(), 1, null, 1)).resolves.toBeUndefined()
    expect(await sweepSessionCpu(broken, { getSessionUsage: async () => null }, 1)).toEqual({ checked: 0, recorded: 0, failed: 0 })
  })
})

describe('session CPU through the lifecycle', () => {
  it('suspend records the session (wall time, vCPUs) without touching the meter; the sweep fills CPU later', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OPERATOR })
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    const sessionId = [...h.vercel.boxes.values()][0]!.sessionId
    h.advance(10 * MIN)
    expect((await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/suspend`)).status).toBe(200)

    const [recorded] = h.raw.prepare('SELECT * FROM session_cpu').all() as any[]
    expect(recorded).toMatchObject({ session_id: sessionId, sandbox_id: body.sandbox.id, account_id: 'user:alice', vcpus: 8, wall_ms: 10 * MIN, active_cpu_ms: null })
    // Billing sees exactly the flat-hours segment, with no CPU anywhere in it.
    expect(h.billing.usage).toHaveLength(1)
    expect(Object.keys(h.billing.usage[0]!).sort()).toEqual(['accountId', 'endedAt', 'machineSize', 'sandboxId', 'startedAt', 'usageId', 'userId'])

    h.vercel.sessionCpu.set(sessionId, 4 * 8 * MIN)
    expect((await operator(h, 'POST', '/v1/internal/session-cpu/sweep')).body).toEqual({ sweep: { checked: 1, recorded: 1, failed: 0 } })
    expect((await operator(h, 'POST', '/v1/internal/session-cpu/sweep')).body.sweep.checked).toBe(0)
    const report = await operator(h, 'GET', '/v1/internal/fair-use')
    expect(report.body.accounts).toEqual([
      { accountId: 'user:alice', sessions: 1, activeCpuMs: 32 * MIN, vcpuMs: 80 * MIN, cpuUtilization: 0.4, fairUseFlag: false }
    ])
  })

  it('a failing CPU fetch never blocks suspend or usage reporting; the sweep backs off', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OPERATOR })
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    h.vercel.failSessionUsage = true
    // Even a D1 table missing entirely must not fail the stop.
    h.raw.exec('ALTER TABLE session_cpu RENAME TO session_cpu_hidden')
    h.advance(5 * MIN)
    expect((await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/suspend`)).status).toBe(200)
    expect(h.billing.usage).toHaveLength(1)
    h.raw.exec('ALTER TABLE session_cpu_hidden RENAME TO session_cpu')

    expect((await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/resume`)).status).toBe(200)
    h.advance(5 * MIN)
    expect((await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/suspend`)).status).toBe(200)
    expect(h.billing.usage).toHaveLength(2)
    expect((await operator(h, 'POST', '/v1/internal/session-cpu/sweep')).body.sweep).toEqual({ checked: 1, recorded: 0, failed: 1 })
    expect((h.raw.prepare('SELECT attempts FROM session_cpu').get() as any).attempts).toBe(1)
  })

  it('a session the provider ended on its own is recorded too', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    const box = [...h.vercel.boxes.values()][0]!
    h.advance(31 * MIN)
    h.vercel.expire(box.params.name)
    await h.reconcile()
    expect(h.raw.prepare('SELECT sandbox_id, wall_ms FROM session_cpu').all()).toEqual([{ sandbox_id: body.sandbox.id, wall_ms: 30 * MIN }])
  })
})

describe('fair-use report', () => {
  async function seed(db: D1Database, account: string, session: string, wallMs: number, vcpus: number, cpuMs: number | null, endedAt: number) {
    await recordSessionEnd(db, row({ id: `sbx_${session}`, account_id: account, session_id: session, session_started_at: endedAt - wallMs }), endedAt, null, endedAt)
    if (cpuMs !== null) {
      await recordSessionEnd(db, row({ session_id: session }), endedAt, { sessionId: session, status: 'stopped', activeCpuMs: cpuMs, durationMs: wallMs, vcpus, memoryMb: null, stoppedAt: endedAt }, endedAt)
    }
  }

  it('averages active CPU over wall × vCPUs per account and flags only above 60%', async () => {
    const { db } = createFakeD1()
    const now = 100 * 24 * 60 * MIN
    const hour = 60 * MIN
    await seed(db, 'org:heavy', 'h1', hour, 8, 6 * hour, now - hour) // 75%
    await seed(db, 'org:heavy', 'h2', hour, 8, 4 * hour, now - 2 * hour) // 50% → combined 62.5%
    await seed(db, 'org:edge', 'e1', hour, 8, 4.8 * hour, now - hour) // exactly 60%: not over
    await seed(db, 'user:light', 'l1', 2 * hour, 4, 0.8 * hour, now - hour) // 10%
    await seed(db, 'user:light', 'old', hour, 8, 8 * hour, now - 31 * 24 * hour) // outside the window
    await seed(db, 'user:light', 'pending', hour, 8, null, now - hour) // no CPU yet: excluded
    const report = await fairUseReport(db, now)
    expect(report).toMatchObject({ windowDays: 30, threshold: FAIR_USE_THRESHOLD, pendingSessions: 1 })
    expect(report.accounts.map((a) => [a.accountId, a.sessions, a.cpuUtilization, a.fairUseFlag])).toEqual([
      ['org:heavy', 2, 0.625, true],
      ['org:edge', 1, 0.6, false],
      ['user:light', 1, 0.1, false]
    ])
    expect(report.accounts[0]).toMatchObject({ activeCpuMs: 10 * hour, vcpuMs: 16 * hour })
  })
})

describe('fair-use auth gate', () => {
  it('refuses customer tokens, wrong tokens and an unset operator token; accepts the operator', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OPERATOR })
    expect((await h.call('GET', '/v1/internal/fair-use')).status).toBe(404)
    expect((await h.call('GET', '/v1/internal/fair-use', { bearer: 'x'.repeat(40) })).status).toBe(404)
    expect((await h.call('POST', '/v1/internal/session-cpu/sweep')).status).toBe(404)
    expect((await operator(h, 'GET', '/v1/internal/fair-use')).body).toMatchObject({ windowDays: 30, accounts: [] })
    expect((await operator(h, 'GET', '/v1/internal/fair-use?days=0')).status).toBe(400)

    const closed = await createHarness()
    const response = await closed.send(
      new Request('https://sandbox.test/v1/internal/fair-use', { headers: { authorization: `Bearer ${OPERATOR}` } })
    )
    expect(response.status).toBe(404)
  })
})
