import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const OPERATOR = 'o'.repeat(40)
const create = (workspaceId: string) => ({ body: { workspaceId, machineSize: 'standard' } })

async function operator(h: Awaited<ReturnType<typeof createHarness>>, method: string, path: string, body?: unknown) {
  const response = await h.send(
    new Request(`https://sandbox.test${path}`, {
      method,
      headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  )
  return { status: response.status, body: (await response.json()) as any }
}

describe('kill switch and caps', () => {
  it('kill switch refuses creates and resumes, drains running sandboxes keeping their disk, and lifts', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OPERATOR })
    const a = await h.call('POST', '/v1/sandboxes', create('ws-a'))
    const b = await h.call('POST', '/v1/sandboxes', { ...create('ws-b'), as: 'bob' })

    expect((await h.call('GET', '/v1/internal/status')).status).toBe(404)
    const on = await operator(h, 'POST', '/v1/internal/kill-switch', { enabled: true })
    expect(on.body).toMatchObject({ killSwitch: true, drained: { suspended: 2, failed: 0, remaining: 0 } })
    for (const box of h.vercel.boxes.values()) {
      expect(box.status).toBe('stopped')
    }
    expect([...h.vercel.snapshots.values()].filter((s) => s.status === 'created')).toHaveLength(2)

    expect(await h.call('POST', '/v1/sandboxes', create('ws-c'))).toEqual({ status: 503, body: { error: 'maintenance' } })
    expect((await h.call('POST', `/v1/sandboxes/${a.body.sandbox.id}/resume`)).body).toEqual({ error: 'maintenance' })
    expect(h.billing.checks).toHaveLength(2)
    expect((await operator(h, 'GET', '/v1/internal/status')).body).toMatchObject({ killSwitch: true, active: 0 })

    await operator(h, 'POST', '/v1/internal/kill-switch', { enabled: false })
    expect((await h.call('POST', `/v1/sandboxes/${b.body.sandbox.id}/resume`, { as: 'bob' })).status).toBe(200)
  })

  it('the cron keeps draining while the kill switch is on; the static env switch also refuses', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OPERATOR })
    await operator(h, 'POST', '/v1/internal/kill-switch', { enabled: true, drain: false })
    expect((await h.call('POST', '/v1/sandboxes', create('ws-a'))).status).toBe(503)
    await operator(h, 'POST', '/v1/internal/kill-switch', { enabled: false })
    await h.call('POST', '/v1/sandboxes', create('ws-a'))
    await operator(h, 'POST', '/v1/internal/kill-switch', { enabled: true, drain: false })
    expect((await h.reconcile()).drained).toBe(1)

    const fixed = await createHarness({ SANDBOX_CREATES_DISABLED: 'true' })
    expect((await fixed.call('POST', '/v1/sandboxes', create('ws-a'))).body).toEqual({ error: 'maintenance' })
  })

  it('global running cap refuses the next start across accounts', async () => {
    const h = await createHarness({ SANDBOX_MAX_RUNNING: '1' })
    expect((await h.call('POST', '/v1/sandboxes', create('ws-a'))).status).toBe(200)
    const res = await h.call('POST', '/v1/sandboxes', { ...create('ws-b'), as: 'bob' })
    expect(res).toEqual({ status: 503, body: { error: 'capacity' } })
    expect(h.vercel.boxes.size).toBe(1)
  })

  it('per-account backstop is 3 per seat even when billing would allow more', async () => {
    const h = await createHarness()
    for (const ws of ['ws-1', 'ws-2', 'ws-3']) {
      expect((await h.call('POST', '/v1/sandboxes', create(ws))).status).toBe(200)
    }
    expect(await h.call('POST', '/v1/sandboxes', create('ws-4'))).toEqual({
      status: 403,
      body: { error: 'entitlement_denied', reason: 'concurrency_limit' }
    })
    h.billing.decision = { allow: true, reason: null, suspendRunning: false, seats: 2 }
    expect((await h.call('POST', '/v1/sandboxes', create('ws-4'))).status).toBe(200)
    expect(h.vercel.boxes.size).toBe(4)
  })

  it('rate limits creates per account per minute', async () => {
    const h = await createHarness({ CREATE_RATE_PER_MINUTE: '2' })
    expect((await h.call('POST', '/v1/sandboxes', create('ws-1'))).status).toBe(200)
    expect((await h.call('POST', '/v1/sandboxes', create('ws-1'))).status).toBe(200)
    expect(await h.call('POST', '/v1/sandboxes', create('ws-2'))).toEqual({ status: 429, body: { error: 'rate_limited' } })
    expect((await h.call('POST', '/v1/sandboxes', { ...create('ws-2'), as: 'bob' })).status).toBe(200)
    h.advance(60_000)
    expect((await h.call('POST', '/v1/sandboxes', create('ws-2'))).status).toBe(200)
  })
})
