import { describe, expect, it } from 'vitest'
import {
  HostedSandboxListResponseSchema,
  HostedSandboxReadyResponseSchema,
  HostedSandboxStatusResponseSchema
} from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { DRAIN_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { GOLDEN, createHarness } from './harness'

const MIN = 60_000
const create = { workspaceId: 'ws-1', machineSize: 'standard' }

describe('sandbox control plane lifecycle', () => {
  it('creates a white-labelled sandbox from the golden image and returns orcad pairing', async () => {
    const h = await createHarness()
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res.status).toBe(200)
    const ready = HostedSandboxReadyResponseSchema.parse(res.body)
    expect(ready.sandbox.status).toBe('running')
    expect(ready.connection.projectRoot).toBe('/vercel/sandbox/project')
    expect(ready.sandbox.session!.deadlineAt - ready.sandbox.session!.startedAt).toBe(23 * 60 * MIN + 50 * MIN)
    expect(ready.sandbox.session!.leaseExpiresAt - ready.sandbox.session!.startedAt).toBe(30 * MIN)

    const [box] = [...h.vercel.boxes.values()]
    expect(box!.params).toMatchObject({
      name: `orca-test-${ready.sandbox.id}`,
      snapshotId: GOLDEN,
      vcpus: 4,
      ports: [6768],
      tags: { orcaSandbox: ready.sandbox.id, orcaEnv: 'test' }
    })
    expect(Object.keys(box!.policy.allow)).not.toContain('*')
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)
    expect(start!.env.ORCA_PUBLIC_WSS).toBe(box!.route.replace('https:', 'wss:'))
    expect(h.billing.checks).toEqual([{ accountId: 'user:alice', runningSandboxes: 0 }])
  })

  it('refuses a start billing denies without touching the provider', async () => {
    const h = await createHarness()
    h.billing.decision = { allow: false, reason: 'concurrency_limit' }
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res).toEqual({ status: 403, body: { error: 'entitlement_denied', reason: 'concurrency_limit' } })
    expect(h.vercel.boxes.size).toBe(0)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM sandboxes').get()).toEqual({ n: 0 })
  })

  it('hides one account’s sandbox from another', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    expect((await h.call('GET', `/v1/sandboxes/${body.sandbox.id}`, { as: 'bob' })).status).toBe(404)
    expect((await h.call('DELETE', `/v1/sandboxes/${body.sandbox.id}`, { as: 'bob' })).status).toBe(404)
    expect(HostedSandboxListResponseSchema.parse((await h.call('GET', '/v1/sandboxes', { as: 'bob' })).body).sandboxes).toEqual([])
    expect(h.vercel.boxes.size).toBe(1)
  })

  it('returns the same environment when a create is retried for the workspace', async () => {
    const h = await createHarness()
    const first = await h.call('POST', '/v1/sandboxes', { body: create })
    const second = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(second.body.sandbox.id).toBe(first.body.sandbox.id)
    expect(h.vercel.boxes.size).toBe(1)
  })

  it('drains before stopping, meters the session, and resumes the same disk', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    const id = body.sandbox.id
    h.advance(20 * MIN)
    const suspended = await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect(HostedSandboxStatusResponseSchema.parse(suspended.body).sandbox).toMatchObject({ status: 'suspended', session: null })
    expect(h.vercel.commands.map((c) => c.command)).toEqual([START_COMMAND, DRAIN_COMMAND])
    expect(h.billing.usage).toEqual([
      expect.objectContaining({ sandboxId: id, accountId: 'user:alice', machineSize: 'standard', endedAt: h.now(), startedAt: h.now() - 20 * MIN })
    ])

    const resumed = HostedSandboxReadyResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${id}/resume`)).body)
    expect(resumed.sandbox.status).toBe('running')
    expect(resumed.sandbox.session!.id).not.toBe(body.sandbox.session.id)
    expect(h.vercel.boxes.size).toBe(1)
    expect(h.billing.checks).toHaveLength(2)
  })

  it('renews the Orca lease but never past the forced-rollover deadline', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    const startedAt = body.sandbox.session.startedAt
    const renewed = await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/lease`, { body: { extendMs: 60 * MIN } })
    expect(renewed.body.sandbox.session.leaseExpiresAt).toBe(h.now() + 60 * MIN)
    h.advance(23 * 60 * MIN + 30 * MIN)
    const clamped = await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/lease`, { body: { extendMs: 60 * MIN } })
    expect(clamped.body.sandbox.session.leaseExpiresAt).toBe(startedAt + 23 * 60 * MIN + 50 * MIN)
  })

  it('rolls a session over onto a fresh one from the same disk', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    h.advance(12 * 60 * MIN)
    const rolled = HostedSandboxReadyResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/rollover`)).body)
    expect(rolled.sandbox.id).toBe(body.sandbox.id)
    expect(rolled.sandbox.session!.startedAt).toBe(h.now())
    expect(h.vercel.commands.map((c) => c.command)).toEqual([START_COMMAND, DRAIN_COMMAND, START_COMMAND])
    expect(h.billing.usage.map((u) => u.endedAt - u.startedAt)).toEqual([12 * 60 * MIN])
  })

  it('destroys the sandbox and every snapshot it left behind, idempotently', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/suspend`)
    await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/resume`)
    expect([...h.vercel.snapshots.values()].filter((s) => s.status === 'created')).toHaveLength(1)

    const destroyed = await h.call('DELETE', `/v1/sandboxes/${body.sandbox.id}`)
    expect(destroyed.body.sandbox.status).toBe('destroyed')
    expect(h.vercel.boxes.size).toBe(0)
    expect([...h.vercel.snapshots.values()].every((s) => s.status === 'deleted')).toBe(true)
    expect((await h.call('DELETE', `/v1/sandboxes/${body.sandbox.id}`)).body.sandbox.status).toBe('destroyed')
    expect((await h.call('GET', '/v1/sandboxes')).body.sandboxes).toEqual([])
  })

  it('cleans up a create whose orcad never came up, so the workspace can retry', async () => {
    const h = await createHarness()
    h.vercel.failStart = true
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res).toEqual({ status: 502, body: { error: 'provider_unavailable', reason: 'orcad_start_failed' } })
    expect(h.vercel.boxes.size).toBe(0)
    h.vercel.failStart = false
    expect((await h.call('POST', '/v1/sandboxes', { body: create })).status).toBe(200)
  })

  it('refuses lifecycle calls until Orca’s provider account is configured', async () => {
    const h = await createHarness({ GOLDEN_SNAPSHOT_ID: undefined })
    expect(await h.call('POST', '/v1/sandboxes', { body: create })).toEqual({ status: 503, body: { error: 'not_configured' } })
  })

  it('rejects tokens minted for another purpose', async () => {
    const h = await createHarness()
    const res = await h.call('GET', '/v1/sandboxes', { bearer: await h.token('alice', undefined, 'billing') })
    expect(res.status).toBe(401)
  })
})

describe('sandbox control plane cron', () => {
  it('stops a sandbox at the forced-rollover deadline when no desktop rolled it over', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/lease`, { body: { extendMs: 60 * MIN } })
    h.advance(23 * 60 * MIN + 50 * MIN)
    expect((await h.reconcile()).suspendedForDeadline).toBe(1)
    expect((await h.call('GET', `/v1/sandboxes/${body.sandbox.id}`)).body.sandbox.status).toBe('suspended')
  })

  it('bills a lapsed lease only up to when the provider stopped it', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    h.advance(45 * MIN)
    h.vercel.expire(`orca-test-${body.sandbox.id}`)
    expect((await h.reconcile()).leaseLapsed).toBe(1)
    expect(h.billing.usage.map((u) => u.endedAt - u.startedAt)).toEqual([30 * MIN])
  })

  it('stops running sandboxes once billing says the included hours are gone', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    h.billing.usageAnswer = { canStartSandbox: false, reason: 'included_hours_exhausted' }
    h.advance(10 * MIN)
    expect((await h.reconcile()).suspendedForBilling).toBe(1)
    expect((await h.call('GET', `/v1/sandboxes/${body.sandbox.id}`)).body.sandbox.status).toBe('suspended')
  })

  it('keeps usage owed while billing is down and reports it once billing is back', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    h.billing.down = true
    h.advance(5 * MIN)
    expect((await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/suspend`)).status).toBe(200)
    expect(h.billing.usage).toEqual([])
    h.billing.down = false
    await h.reconcile()
    expect(h.billing.usage.map((u) => u.endedAt - u.startedAt)).toEqual([5 * MIN])
  })

  it('releases a sandbox whose create died mid-way', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    h.raw.prepare(`UPDATE sandboxes SET status = 'creating' WHERE id = ?`).run(body.sandbox.id)
    h.advance(16 * MIN)
    expect((await h.reconcile()).released).toBe(1)
    expect(h.vercel.boxes.size).toBe(0)
  })
})
